/**
 * Split-explorer data layer: turn a Hedera transaction id into a verified
 * 98/2 tip split — or an honest error.
 *
 * Verification chain (all reads are official Hedera mirror-node REST):
 *  1. The id must be a well-formed Hedera transaction id
 *     (0.0.N@seconds.nanos, 0.0.N-seconds-nanos, or a 0x EVM hash).
 *  2. The transaction must be a contract call TO the Tips contract
 *     0.0.10854060 (entity_id / contract_id from the mirror node) that
 *     reached consensus successfully.
 *  3. The call's logs must contain a TipSent event. Its two data words are
 *     (gross tipped, treasury fee) in tinybar — verified against the
 *     Sourcify-verified VoicescapeTips source:
 *       event TipSent(..., uint256 amount /* total tipped *\/, uint256 fee /* treasury cut *\/)
 *     The creator share is gross − fee, and the page asserts the exact
 *     contract formula fee == gross * 200 / 10000 before calling the split
 *     "exact".
 *
 * No mocks: every number on the /tx page comes from the mirror node.
 * This module is pure + fetch-injectable so it is fully unit-testable.
 */
import { TIPSENT_TOPIC } from "./leaderboard";

/** Deployed, Sourcify-verified Tips contract (mainnet). */
export const TIPS_CONTRACT_ID = "0.0.10854060";

/** HashScan mainnet transaction deep-link base. */
export const HASHSCAN_TX_BASE = "https://hashscan.io/mainnet/transaction";

const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";

/** Contract fee: 200 bps of the gross tip (VoicescapeTips.FEE_BPS). */
const FEE_BPS = 200n;
const BPS_DENOMINATOR = 10_000n;

const TINYBAR_PER_HBAR = 100_000_000n;

export type ProofErrorKind =
  | "malformed" // not a Hedera transaction id at all
  | "not-found" // mirror node has no such transaction (yet)
  | "not-a-tip" // exists, but isn't a successful Tips-contract tip call
  | "reverted" // called the Tips contract but reverted on-chain
  | "network" // mirror node unreachable / 5xx
  | "decode"; // chain answered but the tip data was unreadable

export interface TipProof {
  /** Canonical mirror-node form (dash-separated SDK id or 0x hash). */
  txId: string;
  /** Tipper's EVM address (lowercased 0x…). */
  sender: string;
  /** Page owner's EVM address (lowercased 0x…). */
  recipient: string;
  /** Total tipped, in tinybar (event word 1). */
  grossTinybar: bigint;
  /** Page owner's share = gross − fee, in tinybar. */
  creatorTinybar: bigint;
  /** Treasury's share, in tinybar (event word 2). */
  feeTinybar: bigint;
  /** True when fee == gross * 200 / 10000 exactly (the contract formula). */
  splitExact: boolean;
  /** Mirror-node consensus timestamp ("seconds.nanos"), may be "". */
  consensusTimestamp: string;
}

export type ProofResult =
  | { ok: true; proof: TipProof }
  | { ok: false; error: ProofErrorKind };

type NormalizedId =
  | { ok: true; txId: string; kind: "sdk" | "evm" }
  | { ok: false };

const SDK_AT_RE = /^0\.0\.(\d+)@(\d{1,10})\.(\d{1,9})$/;
const SDK_DASH_RE = /^0\.0\.(\d+)-(\d{1,10})-(\d{1,9})$/;
const EVM_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Validate a transaction id and normalize it to the mirror node's accepted
 * form: dash-separated for SDK ids (the /transactions path rejects @-form),
 * lowercased for EVM hashes.
 */
export function normalizeTxId(raw: string): NormalizedId {
  const t = raw.trim();
  const sdk = SDK_AT_RE.exec(t) ?? SDK_DASH_RE.exec(t);
  if (sdk) {
    return { ok: true, txId: `0.0.${sdk[1]}-${sdk[2]}-${sdk[3]}`, kind: "sdk" };
  }
  if (EVM_HASH_RE.test(t)) {
    return { ok: true, txId: t.toLowerCase(), kind: "evm" };
  }
  return { ok: false };
}

/** Exact tinybar → HBAR decimal string (no float rounding). */
export function tinybarToHbar(tinybar: bigint): string {
  const negative = tinybar < 0n;
  const abs = negative ? -tinybar : tinybar;
  const whole = abs / TINYBAR_PER_HBAR;
  const frac = (abs % TINYBAR_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return (negative ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

/** 98/2 split of a gross amount, in tinybar (BigInt — exact). */
export function computeSplitFromGross(grossTinybar: bigint): {
  creator: bigint;
  fee: bigint;
} {
  const fee = (grossTinybar * FEE_BPS) / BPS_DENOMINATOR;
  return { creator: grossTinybar - fee, fee };
}

function topicToAddress(topic: unknown): string | null {
  if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return "0x" + topic.slice(-40).toLowerCase();
}

/** Decode the TipSent data words: (gross tipped, treasury fee) in tinybar. */
function decodeTipSentData(data: unknown): { gross: bigint; fee: bigint } | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{128,}$/.test(data)) return null;
  try {
    const gross = BigInt("0x" + data.slice(2, 66));
    const fee = BigInt("0x" + data.slice(66, 130));
    if (gross <= 0n || fee < 0n) return null;
    return { gross, fee };
  } catch {
    return null;
  }
}

/**
 * Verify a transaction id against the mirror node and decode its 98/2 tip
 * split. Returns an honest error kind instead of throwing for expected
 * failure modes (malformed id, unknown tx, non-tip tx, mirror outage).
 */
export async function fetchTipProof(
  rawTxId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProofResult> {
  const norm = normalizeTxId(rawTxId);
  if (!norm.ok) return { ok: false, error: "malformed" };
  const fail = (error: ProofErrorKind): ProofResult => ({ ok: false, error });

  let consensusTimestamp = "";

  // Step 1 (SDK ids only): the /transactions endpoint verifies the call
  // target (entity_id) and the consensus result. It does not accept EVM
  // hashes, so 0x inputs skip straight to the contract-results endpoint.
  if (norm.kind === "sdk") {
    let res: Response;
    try {
      res = await fetchImpl(`${MIRROR_BASE}/transactions/${norm.txId}`, {
        cache: "no-store",
      });
    } catch {
      return fail("network");
    }
    if (res.status === 404) return fail("not-found");
    if (!res.ok) return fail("network");
    let body: { transactions?: Array<Record<string, unknown>> };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return fail("decode");
    }
    const tx = body?.transactions?.[0];
    if (!tx) return fail("not-found");
    if (typeof tx.entity_id === "string" && tx.entity_id !== TIPS_CONTRACT_ID) {
      return fail("not-a-tip");
    }
    if (typeof tx.result === "string" && tx.result !== "SUCCESS") {
      return fail("reverted");
    }
    if (typeof tx.consensus_timestamp === "string") {
      consensusTimestamp = tx.consensus_timestamp;
    }
  }

  // Step 2: the contract-results endpoint carries the logs (works for both
  // SDK ids and EVM hashes) and independently confirms the call target.
  let res: Response;
  try {
    res = await fetchImpl(`${MIRROR_BASE}/contracts/results/${norm.txId}`, {
      cache: "no-store",
    });
  } catch {
    return fail("network");
  }
  if (res.status === 404) return fail("not-found");
  if (!res.ok) return fail("network");
  let data: {
    status?: string;
    contract_id?: string;
    logs?: Array<{ topics?: unknown[]; data?: unknown; timestamp?: unknown }>;
    results?: Array<{
      status?: string;
      contract_id?: string;
      logs?: Array<{ topics?: unknown[]; data?: unknown; timestamp?: unknown }>;
    }>;
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return fail("decode");
  }
  const r = data?.results?.[0] ?? data;
  if (!r) return fail("not-found");
  if (typeof r.status === "string" && r.status !== "0x1") return fail("reverted");
  if (typeof r.contract_id === "string" && r.contract_id !== TIPS_CONTRACT_ID) {
    return fail("not-a-tip");
  }

  // Step 3: find the TipSent event. A Tips-contract call without it (e.g. a
  // marketplace purchase) is honestly "not a tip", never a fabricated split.
  const logs = Array.isArray(r.logs) ? r.logs : [];
  const tipLog = logs.find(
    (l) =>
      Array.isArray(l?.topics) &&
      typeof l.topics[0] === "string" &&
      (l.topics[0] as string).toLowerCase() === TIPSENT_TOPIC,
  );
  if (!tipLog) return fail("not-a-tip");

  const decoded = decodeTipSentData(tipLog.data);
  const sender = topicToAddress(tipLog.topics?.[2]);
  const recipient = topicToAddress(tipLog.topics?.[3]);
  if (!decoded || !sender || !recipient) return fail("decode");
  if (!consensusTimestamp && typeof tipLog.timestamp === "string") {
    consensusTimestamp = tipLog.timestamp;
  }

  const creator = decoded.gross - decoded.fee;
  const splitExact = decoded.fee === (decoded.gross * FEE_BPS) / BPS_DENOMINATOR;
  return {
    ok: true,
    proof: {
      txId: norm.txId,
      sender,
      recipient,
      grossTinybar: decoded.gross,
      creatorTinybar: creator,
      feeTinybar: decoded.fee,
      splitExact,
      consensusTimestamp,
    },
  };
}

/** Canonical public proof URL for a transaction id. */
export function buildTipProofUrl(origin: string, txId: string): string {
  return `${origin.replace(/\/+$/, "")}/tx/${encodeURIComponent(txId)}`;
}

/**
 * Fill the (localized) share-text template. Placeholders: {hbar}, {username},
 * {url}. Kept as a pure function so every language's template is testable.
 */
export function fillTipShareText(
  template: string,
  hbar: string,
  username: string,
  proofUrl: string,
): string {
  return template
    .split("{hbar}")
    .join(hbar)
    .split("{username}")
    .join(username)
    .split("{url}")
    .join(proofUrl);
}

/** X share intent carrying the filled share text (which embeds the proof URL). */
export function buildTipShareIntentUrl(text: string): string {
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

/** Shorten an EVM address for display when no username resolves. */
export function shortAddress(address: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
  }
  return address;
}
