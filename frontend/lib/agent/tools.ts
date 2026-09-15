/**
 * Voicescape onboarding-buddy tools (read-only).
 *
 * Ported from ~/workspace/ops/voicescape-agent/src/tools.ts for the dapp
 * chat widget. All reads go through the public Hedera mainnet mirror node
 * REST API. No signing, no spending, no private keys — these tools never write.
 *
 * `ethers` is used for ABI encode/decode ONLY, never as a chain connection
 * (deploy-gate rule).
 */
import { AbiCoder, id as keccakId } from "ethers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIRROR = "https://mainnet.mirrornode.hedera.com/api/v1";

export const REGISTRY_ID = "0.0.10854058";
export const REGISTRY_EVM = "0xd87f8113c5bcc47c40dc26a43ffa9b1629385a58";
export const TIPS_ID = "0.0.10854060";

/** resolvePage(string) — computed, not hardcoded */
export const RESOLVE_PAGE_SELECTOR = keccakId("resolvePage(string)").slice(0, 10);

/** Node fee-collection accounts — excluded when finding a tip recipient. */
const FEE_ACCOUNTS = new Set(["0.0.800", "0.0.801", "0.0.802", "0.0.98"]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const abi = AbiCoder.defaultAbiCoder();
const tinybarToHbar = (t: number | string) => Number(t) / 100_000_000;

function evmAddressToAccountId(addr: string): string {
  return `0.0.${BigInt(addr).toString()}`;
}

async function mirrorGet(path: string, signal?: AbortSignal): Promise<any> {
  const res = await fetch(`${MIRROR}${path}`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`mirror node GET ${path}: HTTP ${res.status}`);
  return res.json();
}

async function mirrorContractCall(
  to: string,
  data: string,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch(`${MIRROR}/contracts/call`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      to,
      data,
      estimate: false,
      gas: 15_000_000,
      gasPrice: 1,
      value: 0,
    }),
    signal,
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(
      `mirror node contracts/call: HTTP ${res.status} ${bodyText.slice(0, 300)}`
    );
  }
  const body = await res.json();
  if (!body.result) throw new Error(`mirror node contracts/call: no result field`);
  return body.result as string;
}

// ---------------------------------------------------------------------------
// Tool 1: resolve_blockpage
// ---------------------------------------------------------------------------

export interface ResolveBlockpageResult {
  registered: boolean;
  username: string;
  ownerAccountId: string | null;
  ownerEvmAddress: string | null;
  ownerType: "HUMAN" | "AGENT" | "UNKNOWN";
  ownerTypeRaw: number | null;
  ipfsHash: string | null;
  operatorEvmAddress: string | null;
  purpose: string | null;
}

export async function resolveBlockpage(
  username: string,
  signal?: AbortSignal
): Promise<ResolveBlockpageResult> {
  const clean = String(username ?? "").slice(0, 64);
  if (!clean) throw new Error("username is required");
  const data = RESOLVE_PAGE_SELECTOR + abi.encode(["string"], [clean]).slice(2);
  let result: string;
  try {
    result = await mirrorContractCall(REGISTRY_EVM, data, signal);
  } catch (e: any) {
    // The Registry reverts on unknown usernames (CONTRACT_REVERT_EXECUTED,
    // surfaced by the mirror node as HTTP 400) — that means "not registered".
    if (String(e?.message ?? e).includes("CONTRACT_REVERT_EXECUTED")) {
      return {
        registered: false,
        username: clean,
        ownerAccountId: null,
        ownerEvmAddress: null,
        ownerType: "UNKNOWN",
        ownerTypeRaw: null,
        ipfsHash: null,
        operatorEvmAddress: null,
        purpose: null,
      };
    }
    throw e;
  }
  const [owner, ipfsHash, ownerTypeRaw, operator, purpose] = abi.decode(
    ["address", "string", "uint8", "address", "string"],
    result
  ) as unknown as [string, string, bigint, string, string];

  const registered = owner.toLowerCase() !== ZERO_ADDRESS;
  const raw = Number(ownerTypeRaw);
  return {
    registered,
    username: clean,
    ownerAccountId: registered ? evmAddressToAccountId(owner) : null,
    ownerEvmAddress: registered ? owner : null,
    ownerType: !registered ? "UNKNOWN" : raw === 1 ? "AGENT" : raw === 0 ? "HUMAN" : "UNKNOWN",
    ownerTypeRaw: registered ? raw : null,
    ipfsHash: registered ? ipfsHash : null,
    operatorEvmAddress: registered ? operator : null,
    purpose: registered ? purpose : null,
  };
}

// ---------------------------------------------------------------------------
// Tool 2: verify_tip
// ---------------------------------------------------------------------------

export interface VerifyTipResult {
  transactionId: string;
  success: boolean;
  result: string;
  calledTipsContract: boolean;
  entityId: string | null;
  consensusTimestamp: string;
  amountSentHbar: number | null;
  functionSelector: string | null;
  targetUsername: string | null;
  recipientAccountId: string | null;
  deliveredHbar: number | null;
  chargedFeeHbar: number;
  transfers: { account: string; hbar: number }[];
  note: string | null;
}

const TX_ID_RE = /^\d+\.\d+\.\d+-\d+-\d+$/;

export async function verifyTip(
  transactionId: string,
  signal?: AbortSignal
): Promise<VerifyTipResult> {
  const txId = String(transactionId ?? "");
  if (!TX_ID_RE.test(txId)) throw new Error("invalid transaction id format");
  const txBody = await mirrorGet(`/transactions/${txId}`, signal);
  const tx = txBody?.transactions?.[0];
  if (!tx) throw new Error(`transaction not found: ${txId}`);

  const transfers: { account: string; hbar: number }[] = (tx.transfers ?? []).map(
    (t: any) => ({ account: t.account, hbar: tinybarToHbar(t.amount) })
  );
  // Recipient = largest positive transfer that isn't a node fee account.
  const recipient = (tx.transfers ?? [])
    .filter((t: any) => Number(t.amount) > 0 && !FEE_ACCOUNTS.has(t.account))
    .sort((a: any, b: any) => Number(b.amount) - Number(a.amount))[0];

  // Calldata isn't exposed on the transaction record; the contract-results
  // endpoint carries it. Best effort — never fails the tool.
  let functionSelector: string | null = null;
  let targetUsername: string | null = null;
  let amountSentHbar: number | null = null;
  let note: string | null = null;
  try {
    const cr = await mirrorGet(`/contracts/results/${txId}`, signal);
    if (cr?.function_parameters && typeof cr.function_parameters === "string") {
      functionSelector = cr.function_parameters.slice(0, 10);
      try {
        const [decoded] = abi.decode(["string"], "0x" + cr.function_parameters.slice(10));
        targetUsername = decoded as string;
      } catch {
        targetUsername = null; // calldata isn't a single string arg — fine
      }
    }
    if (cr?.amount != null) amountSentHbar = tinybarToHbar(cr.amount);
  } catch {
    note = "contract-results lookup unavailable; selector/username omitted";
  }

  return {
    transactionId: txId,
    success: tx.result === "SUCCESS",
    result: tx.result,
    calledTipsContract: tx.entity_id === TIPS_ID,
    entityId: tx.entity_id ?? null,
    consensusTimestamp: tx.consensus_timestamp,
    amountSentHbar,
    functionSelector,
    targetUsername,
    recipientAccountId: recipient ? recipient.account : null,
    deliveredHbar: recipient ? tinybarToHbar(recipient.amount) : null,
    chargedFeeHbar: tinybarToHbar(tx.charged_tx_fee ?? 0),
    transfers,
    note,
  };
}

// ---------------------------------------------------------------------------
// Tool 3: treasury_stats
// ---------------------------------------------------------------------------

export interface TreasuryStatsResult {
  windowHours: number;
  windowStart: string;
  windowEnd: string;
  directCalls: number;
  totalHbar: number;
  selectors: Record<string, number>;
}

export async function treasuryStats(
  hoursBack: number = 24,
  signal?: AbortSignal
): Promise<TreasuryStatsResult> {
  const window = Math.min(168, Math.max(1, Math.floor(Number(hoursBack) || 24)));
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - window * 3600;
  // NOTE: account.id filtering does not match contract-call transactions
  // (the contract is not in the transfer list), so we use the contract
  // results endpoint. The `to` field there uses the long-zero address form
  // (0x0000...a59eac), not the contract's evm_address — compare by account id.
  const body = await mirrorGet(
    `/contracts/${TIPS_ID}/results?timestamp=gte:${fromSec}&limit=100&order=desc`,
    signal
  );
  const direct = (body?.results ?? []).filter(
    (r: any) => typeof r.to === "string" && evmAddressToAccountId(r.to) === TIPS_ID
  );
  const selectors: Record<string, number> = {};
  let totalTinybar = 0;
  let oldest: string | null = null;
  for (const r of direct) {
    totalTinybar += Number(r.amount ?? 0);
    const sel = String(r.function_parameters ?? "").slice(0, 10) || "unknown";
    selectors[sel] = (selectors[sel] ?? 0) + 1;
    if (!oldest || r.timestamp < oldest) oldest = r.timestamp;
  }
  return {
    windowHours: window,
    windowStart: new Date(fromSec * 1000).toISOString(),
    windowEnd: new Date(nowSec * 1000).toISOString(),
    directCalls: direct.length,
    totalHbar: tinybarToHbar(totalTinybar),
    selectors,
  };
}
