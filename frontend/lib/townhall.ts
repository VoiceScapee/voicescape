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
  Client,
  Hbar,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { getHederaPairing } from "./wallet";
import { fetchWithTimeout } from "./fetch-timeout";
import {
  getMirrorHeadTimestampMs,
  isMirrorBeyondTxWindow,
  MIRROR_CATCHUP_MARGIN_MS,
  toMirrorTxId,
} from "./tx-confirm";
import {
  type LandedStatus,
  listPendingIntents,
  reconcilePendingIntents,
  removePendingIntent,
  savePendingIntent,
} from "./pending-intents";
import { isWalletRejection } from "./wallet-guards";

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
  /** False when the author's identity wasn't attested via the API write path. */
  authorVerified?: boolean;
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
  /** False when the author's identity wasn't attested via the API write path. */
  authorVerified?: boolean;
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
    res = await fetch(url, {
      headers: { accept: "application/json", ...getAuthHeaders() },
    });
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
/* Client-side id generation (user-signed HCS architecture)           */
/* ------------------------------------------------------------------ */

/**
 * URL-safe id + short random suffix, matching the server's makeId.
 * The client generates the id, includes it in the HCS message AND the POST
 * body — the server uses the body id so the returned id matches the
 * on-chain message.
 */
export function makeTownhallId(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "item";
  return `${slug}-${Date.now().toString(36)}`;
}

/* ------------------------------------------------------------------ */
/* Dust-fee payment (HBAR transfer to the treasury, wallet-signed)     */
/* ------------------------------------------------------------------ */

function toAccountId(addr: string): AccountId {
  if (/^0x[0-9a-fA-F]{40}$/.test(addr)) return AccountId.fromEvmAddress(0, 0, addr);
  return AccountId.fromString(addr);
}

/**
 * Check whether a dust-fee HBAR transfer actually executed, via the mirror
 * node (transfers aren't contract calls, so the contracts/results endpoint
 * doesn't apply). Bounded — a mirror stall degrades to "unknown", never a
 * hang. "expired" means the mirror indexed past the tx's validity window
 * without seeing it: it can never land, so a retry is safe.
 */
const DUST_CHECK_TIMEOUT_MS = 10_000;
async function checkDustTxLanded(txId: string): Promise<LandedStatus> {
  const url =
    `https://mainnet.mirrornode.hedera.com/api/v1/transactions/` +
    encodeURIComponent(toMirrorTxId(txId));
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DUST_CHECK_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const headMs = await getMirrorHeadTimestampMs();
      if (isMirrorBeyondTxWindow(txId, headMs, MIRROR_CATCHUP_MARGIN_MS)) return "expired";
      return "unknown";
    }
    const data = (await res.json()) as { transactions?: Array<{ result?: string }> };
    const result = data.transactions?.[0]?.result;
    if (result === "SUCCESS") return "success";
    if (result) return "failed";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Reconcile stored dust-fee intents for this account. A previous attempt
 * whose outcome is still unknown BLOCKS a new payment — retrying blind
 * would charge the user twice for one post. Resolved intents are cleared.
 */
async function gateUnresolvedDustFee(account: string): Promise<void> {
  await reconcilePendingIntents(checkDustTxLanded);
  const blocked = listPendingIntents().filter(
    (i) => i.account === account && i.kind === "dust-fee",
  );
  if (blocked.length > 0) {
    const txIds = blocked.map((i) => i.txId).join(", ");
    throw new Error(
      `A dust-fee payment from this wallet is still unconfirmed (${txIds}). ` +
        `Check its status on HashScan before paying again — paying again now could charge you twice.`,
    );
  }
}

/**
 * Send `tinybars` of HBAR to `treasury` (0.0.x or 0x…), signed by the
 * connected Hedera wallet via DAppConnector (HIP-820). Resolves to the tx
 * id to pass as dustFeeTxId.
 *
 * Same honesty discipline as lib/tx.ts executeWrite: 30s wallet timeout,
 * mirror verification on silence, and a pending-intent guard so retrying
 * after a hang can't silently charge the user twice for one post.
 */
export async function sendDustFeeTo(treasury: string, tinybars: bigint): Promise<string> {
  if (tinybars <= 0n) throw new Error("Dust fee must be greater than zero.");
  const pairing = getHederaPairing();
  if (!pairing) {
    throw new Error("Connect a Hedera wallet (e.g. HashPack) to pay the dust fee.");
  }
  const { hc, accountId } = pairing;
  const payer = AccountId.fromString(accountId);
  // Double-payment guard FIRST: if a previous dust-fee attempt from this
  // wallet is still unconfirmed, refuse a new payment until its outcome is
  // known. A fresh txId per attempt means a blind retry would pay twice.
  await gateUnresolvedDustFee(accountId);
  const amount = Hbar.fromTinybars(tinybars.toString());
  const tx = new TransferTransaction()
    .addHbarTransfer(payer, amount.negated())
    .addHbarTransfer(toAccountId(treasury), amount);
  // Freeze the tx body so the wallet can sign it (HIP-820). Do NOT use
  // freezeWithSigner here: the DAppSigner's populateTransaction only sets
  // the transaction id — it never sets node account ids — so freeze()
  // throws "`nodeAccountId` must be set or `client` must be provided with
  // `freezeWith`". Set the tx id from the payer and freeze with a public
  // network client; freezeWith signs nothing, the wallet signs via
  // signAndExecuteTransaction.
  const { getActiveChain } = await import("./chains");
  const chain = getActiveChain();
  const networkClient = Client.forMainnet(); // mainnet only — no testnet
  try {
    tx.setTransactionId(TransactionId.generate(payer));
    tx.freezeWith(networkClient);
  } finally {
    networkClient.close(); // never leak the gRPC client per town-hall write
  }
  const txId = tx.transactionId?.toString() ?? "";
  // Persist the intent before the wallet signs — cleared below on
  // definitive outcomes. An "unknown" outcome stays stored so the next
  // payFee reconciles instead of double-paying.
  savePendingIntent({
    txId,
    kind: "dust-fee",
    label: `Dust fee ${tinybars.toString()} tinybars`,
    account: accountId,
    createdAt: Date.now(),
  });
  // DAppConnector signs AND executes via the wallet (HIP-820).
  const { transactionToBase64String } = await import("@hashgraph/hedera-wallet-connect");
  const network = "mainnet"; // mainnet only — no testnet
  // 30s wallet timeout (same as executeWrite): without it a silent wallet
  // hangs the UI on "paying" forever, and a retry would pay the fee twice.
  const WALLET_TIMEOUT_MS = 30_000;
  let walletResponded = false;
  try {
    await Promise.race([
      (async () => {
        await (hc.signAndExecuteTransaction as unknown as (params: object) => Promise<unknown>)({
          signerAccountId: `hedera:${network}:${accountId}`,
          transactionList: transactionToBase64String(tx as unknown as Parameters<typeof transactionToBase64String>[0]),
        });
        walletResponded = true;
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("WALLET_TIMEOUT")), WALLET_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    if (e instanceof Error && e.message === "WALLET_TIMEOUT" && !walletResponded) {
      // Wallet went silent — verify on-chain before giving up. Bounded:
      // a mirror stall must not hang the user a second time.
      const landed = await checkDustTxLanded(txId);
      if (landed === "success") {
        removePendingIntent(txId);
        return txId;
      }
      if (landed === "failed") {
        removePendingIntent(txId);
        throw new Error("The dust-fee transaction failed on-chain. No payment was sent.");
      }
      if (landed === "expired") {
        // Never reached the network — nothing was sent, safe to retry.
        removePendingIntent(txId);
        throw new Error(
          "The dust-fee transaction never reached the Hedera network — nothing was sent and it's safe to retry.",
        );
      }
      // Outcome genuinely unknown: the wallet may have broadcast it. The
      // intent stays stored — the next attempt is gated until this resolves.
      // Never a silent hang, never permission to blindly re-pay.
      throw new Error(
        `The wallet didn't respond, and the dust-fee payment's outcome is unknown. ` +
          `Check ${txId} on HashScan before retrying — retrying now could charge you twice.`,
      );
    }
    // A rejected signature is never broadcast — clear the intent so a
    // routine "decline" doesn't block the next attempt.
    if (isWalletRejection(e)) {
      removePendingIntent(txId);
    }
    throw e;
  }
  if (!txId) {
    removePendingIntent(txId);
    throw new Error("Wallet did not return a transaction id.");
  }
  // Wallet responded: the transfer was submitted. Clear the intent — the
  // server verifies the dustFeeTxId next, and a later payFee is a conscious
  // new attempt, not a blind retry of a hang.
  removePendingIntent(txId);
  return txId;
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
    const solidity = `0x${AccountId.fromString(account).toEvmAddress().toLowerCase()}`;
    return solidity === o;
  } catch {
    return false;
  }
}

/** "0.0.x" → 0x solidity address (best effort; returns input on failure). */
export function accountToEvmAddress(account: string): string {
  try {
    return `0x${AccountId.fromString(account).toEvmAddress()}`;
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
