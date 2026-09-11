/**
 * Social Town Hall — shared client library.
 *
 * API contract (built against the services worker's spec; see task brief):
 *   GET  /api/townhall/boards
 *   GET  /api/townhall/posts?board=&wall=&limit=&before=
 *   POST /api/townhall/posts                      (402 → dust fee)
 *   GET  /api/townhall/reputation?target=&voter=
 *   POST /api/townhall/reputation
 *   GET  /api/townhall/proposals
 *   POST /api/townhall/proposals                   (402 → dust fee)
 *   POST /api/townhall/proposals/[id]/vote
 *   GET  /api/townhall/chat/[room]/stream          (SSE)
 *   POST /api/townhall/chat/[room]                 (402 → dust fee)
 *   GET  /api/townhall/events
 *   POST /api/townhall/events
 *   GET  /api/townhall/listings
 *   POST /api/townhall/listings                    (402 → dust fee)
 *   POST /api/townhall/listings/[id]/status
 *
 * Marketplace sales are direct and atomic (no escrow): the buyer calls
 * VoicescapeTips.buyListing(seller, listingRef) with the price attached —
 * one transaction splits 98% to the seller and 2% to the treasury.
 */
import { getAuthHeaders } from "./auth-client";
import {
  AccountId,
  Hbar,
  TransferTransaction,
} from "@hashgraph/sdk";
import { getHederaPairing } from "./wallet";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface Board {
  id: string;
  title: string;
  description: string;
}

export interface TownhallPost {
  seq: number;
  board: string;
  wall?: string;
  author: string;
  body: string;
  replyTo?: number | null;
  ts: number;
}

export interface Proposal {
  id: string;
  author: string;
  title: string;
  body: string;
  /** Epoch ms. */
  closesAt: number;
  yes: number;
  no: number;
  abstain: number;
}

export interface Listing {
  id: string;
  seller: string;
  sellerUsername?: string | null;
  title: string;
  description: string;
  /** Integer cents. */
  priceUsdCents: number;
  goodsType: "physical" | "digital";
  ipfsHash?: string;
  status?: "active" | "sold" | "cancelled" | string;
  ts?: number;
}



export interface TownhallEvent {
  id: string;
  title: string;
  description: string;
  /** Epoch ms. */
  startsAt: number;
  room: string;
}

export interface ChatMessage {
  seq: number;
  room: string;
  author: string;
  body: string;
  ts: number;
}

export interface ReputationInfo {
  target: string;
  up: number;
  down: number;
  score: number;
  /** The requesting voter's current vote. */
  myVote: 1 | -1 | 0;
}

/* ------------------------------------------------------------------ */
/* API helpers                                                         */
/* ------------------------------------------------------------------ */

/** Thrown by postJson() when the server answers 402 with dust-fee terms. */
export class DustFeeRequired extends Error {
  readonly dustFeeTinybars: number;
  readonly treasury: string;
  constructor(dustFeeTinybars: number, treasury: string) {
    super(
      `Dust fee required: ${(dustFeeTinybars / 100_000_000).toFixed(6)} HBAR to ${treasury}`,
    );
    this.name = "DustFeeRequired";
    this.dustFeeTinybars = dustFeeTinybars;
    this.treasury = treasury;
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { _raw: text };
  }
}

function apiErrorMessage(json: unknown, fallback: string): string {
  if (json && typeof json === "object" && "error" in json) {
    const e = (json as { error?: unknown }).error;
    if (typeof e === "string" && e) return e;
  }
  return fallback;
}

export async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new Error(`Town Hall API unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = await readJson(res);
  if (!res.ok) throw new Error(apiErrorMessage(json, `Request failed (${res.status})`));
  return json as T;
}

/**
 * POST JSON; throws DustFeeRequired on 402 {dustFeeTinybars, treasury}.
 * The caller retries with dustFeeTxId after paying the fee.
 */
export async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...getAuthHeaders(),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Town Hall API unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = await readJson(res);
  if (res.status === 402) {
    const j = (json ?? {}) as { dustFeeTinybars?: unknown; treasury?: unknown };
    const tinybars = Number(j.dustFeeTinybars ?? 0);
    const treasury = String(j.treasury ?? "");
    if (!(tinybars > 0) || !treasury) {
      throw new Error("Server asked for a dust fee but did not say how much or where to send it.");
    }
    throw new DustFeeRequired(tinybars, treasury);
  }
  if (!res.ok) throw new Error(apiErrorMessage(json, `Request failed (${res.status})`));
  return json as T;
}

/* ------------------------------------------------------------------ */
/* Dust-fee payment (HBAR transfer to the treasury, wallet-signed)     */
/* ------------------------------------------------------------------ */

function toAccountId(addr: string): AccountId {
  if (/^0x[0-9a-fA-F]{40}$/.test(addr)) return AccountId.fromEvmAddress(0, 0, addr);
  return AccountId.fromString(addr);
}

/**
 * Send `tinybars` of HBAR to `treasury` (0.0.x or 0x…), signed by the
 * connected wallet. Resolves to the tx id / hash to pass as dustFeeTxId.
 * Hedera wallets go through HashConnect; EVM wallets through the injected
 * provider's eth_sendTransaction.
 */
export async function sendDustFeeTo(treasury: string, tinybars: bigint): Promise<string> {
  if (tinybars <= 0n) throw new Error("Dust fee must be greater than zero.");
  const pairing = getHederaPairing();
  if (pairing) {
    const { hc, accountId } = pairing;
    const payer = AccountId.fromString(accountId);
    const amount = Hbar.fromTinybars(tinybars.toString());
    const tx = new TransferTransaction()
      .addHbarTransfer(payer, amount.negated())
      .addHbarTransfer(toAccountId(treasury), amount);
    // DAppConnector.getSigner returns a hiero-sdk DAppSigner; cast to the
    // hashgraph-sdk Signer — the two SDKs are runtime-compatible.
    const signer = (hc.getSigner as unknown as (id: unknown) => Parameters<typeof tx.freezeWithSigner>[0])(payer);
    await tx.freezeWithSigner(signer);
    const txId = tx.transactionId?.toString() ?? "";
    // DAppConnector signs AND executes via the wallet (HIP-820).
    const { transactionToBase64String } = await import("@hashgraph/hedera-wallet-connect");
    const { getActiveChain } = await import("./chains");
    const chain = getActiveChain();
    const network = chain.key === "hedera-mainnet" ? "mainnet" : "testnet";
    await (hc.signAndExecuteTransaction as unknown as (params: object) => Promise<unknown>)({
      signerAccountId: `hedera:${network}:${accountId}`,
      transactionList: transactionToBase64String(tx as unknown as Parameters<typeof transactionToBase64String>[0]),
    });
    if (!txId) throw new Error("Wallet did not return a transaction id.");
    return txId;
  }
  const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
  if (!eth?.request) throw new Error("Connect a wallet to pay the dust fee.");
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.[0]) throw new Error("The wallet returned no accounts.");
  const wei = tinybars * 10_000_000_000n; // 1 tinybar = 10^10 wei
  const hash = (await eth.request({
    method: "eth_sendTransaction",
    params: [{ from: accounts[0], to: treasury, value: `0x${wei.toString(16)}` }],
  })) as string;
  return hash;
}

/* ------------------------------------------------------------------ */
/* Direct sale — one atomic transaction, no escrow                     */
/* ------------------------------------------------------------------ */

/**
 * Marketplace sales settle through the VoicescapeTips contract's
 * buyListing(seller, listingRef): one wallet transaction splits 98% to the
 * seller and 2% to the treasury atomically. The contract never holds buyer
 * funds — there is no escrow, no locking, no custody, and no buyer
 * protection. Delivery of the goods happens off-chain (chat / page wall /
 * whatever channel buyer and seller agree on). The wallet call itself lives
 * in lib/contracts.ts (buyListing) via the TxSender; this module only
 * records completed purchases locally so the buyer keeps a receipt trail.
 */

/** A completed direct-sale purchase, recorded in localStorage at buy time. */
export interface Purchase {
  listingId: string;
  note?: string;
  /** tx hash (EVM) or tx id (Hedera). */
  tx: string;
  /** HBAR amount the buyer paid (display string). */
  amountHbar: string;
  seller: string;
  boughtAt: number;
}

const PURCHASES_KEY = "vs-townhall-purchases";

export function getPurchases(): Purchase[] {
  try {
    const raw = window.localStorage.getItem(PURCHASES_KEY);
    const list = raw ? (JSON.parse(raw) as Purchase[]) : [];
    return Array.isArray(list)
      ? list.filter((p) => p && typeof p.tx === "string")
      : [];
  } catch {
    return [];
  }
}

export function recordPurchase(entry: Omit<Purchase, "boughtAt">): void {
  try {
    const list = getPurchases().filter(
      (p) => p.tx !== entry.tx || p.listingId !== entry.listingId,
    );
    list.unshift({ ...entry, boughtAt: Date.now() });
    window.localStorage.setItem(PURCHASES_KEY, JSON.stringify(list.slice(0, 100)));
  } catch {
    // best effort
  }
}

export function removePurchase(tx: string, listingId: string): void {
  try {
    const list = getPurchases().filter(
      (p) => p.tx !== tx || p.listingId !== listingId,
    );
    window.localStorage.setItem(PURCHASES_KEY, JSON.stringify(list));
  } catch {
    // best effort
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** Does this wallet account own the page whose registry owner is `owner`? */
export function walletOwnsPage(account: string, owner: string): boolean {
  const a = account.trim().toLowerCase();
  const o = owner.trim().toLowerCase();
  if (!a || !o) return false;
  if (a === o) return true;
  try {
    // Hedera "0.0.x" account ids → their 0x solidity address.
    const solidity = `0x${AccountId.fromString(account).toSolidityAddress().toLowerCase()}`;
    return solidity === o;
  } catch {
    return false;
  }
}

/** "0.0.x" → 0x solidity address (best effort; returns input on failure). */
export function accountToEvmAddress(account: string): string {
  try {
    return `0x${AccountId.fromString(account).toSolidityAddress()}`;
  } catch {
    return account;
  }
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatHbarFromTinybars(tinybars: bigint): string {
  const whole = tinybars / 100_000_000n;
  const frac = tinybars % 100_000_000n;
  return `${whole.toString()}.${frac.toString().padStart(8, "0").replace(/0+$/, "") || "0"}`;
}

/** On the Hedera EVM, 1 tinybar = 10^10 wei (1 HBAR = 10^8 tinybar = 10^18 wei). */
const WEI_PER_TINYBAR = 10_000_000_000n;

/** Wei → HBAR display string. */
export function formatHbarFromWei(wei: bigint): string {
  return formatHbarFromTinybars(wei / WEI_PER_TINYBAR);
}

export function usdToHbarDisplay(usd: number, hbarUsdPrice: number | null): string {
  if (!hbarUsdPrice || !(usd > 0)) return "…";
  return `≈ ${(usd / hbarUsdPrice).toFixed(4)} HBAR`;
}

/**
 * Split a listing's seller field into a payable address and a page
 * username. The API contract names the field `seller`; we accept an
 * address there, or a username with the address in `sellerAddress`.
 */
export function parseSeller(listing: Listing): { address: string | null; username: string | null } {
  const l = listing as Listing & { sellerAddress?: string; sellerUsername?: string; sellerPage?: string };
  const looksAddr = (s: string | undefined) =>
    !!s && (/^0x[0-9a-fA-F]{40}$/.test(s) || /^\d+\.\d+\.\d+$/.test(s));
  const address =
    (looksAddr(l.sellerAddress) ? l.sellerAddress! : null) ??
    (looksAddr(l.seller) ? l.seller : null);
  const username =
    l.sellerUsername ?? l.sellerPage ?? (!looksAddr(l.seller) && l.seller ? l.seller : null);
  return { address, username };
}
