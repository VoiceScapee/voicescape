/**
 * NetworkPulse logic — the dapp-wide global pulse (heartbeat layer 1).
 *
 * Every page on Voicescape shows a quiet dot that pulses once per newly
 * settled Hedera mainnet block, polled from the public mirror-node REST
 * endpoint `GET /api/v1/blocks`. Pure reads, a few hundred bytes per
 * call, far under the mirror's per-IP rate limit. $0 operating cost —
 * no new infra, no server billing.
 *
 * Honesty rules (no exceptions):
 * - One real event = one motion: a pulse fires ONLY when the observed
 *   block number increments. Never simulate during idle or maintenance.
 * - Never merge multiple blocks into one pulse: a small catch-up gap
 *   pulses once per block, staggered so each is perceptible.
 * - A large gap (slept tab, long mirror outage) resyncs SILENTLY — we
 *   don't claim motion for blocks we never observed.
 * - On mirror error or throttle (429), go silent until blocks resume:
 *   no pulses, dim dot, keep polling at a backoff cadence.
 *
 * This module holds the pure, testable decision functions. The UI lives
 * in components/NetworkPulse.tsx.
 */

/** Latest-block query: one block, a few hundred bytes. */
export const MIRROR_BLOCKS_URL =
  "https://mainnet.mirrornode.hedera.com/api/v1/blocks?order=desc&limit=1";
/** Poll cadence while the tab is visible (~7–10s per the verified design). */
export const PULSE_POLL_MS = 8_000;
/** Backoff cadence after a mirror error/throttle, until blocks resume. */
export const PULSE_POLL_SILENT_MS = 30_000;
/** Stagger between catch-up pulses so each block's pulse is perceptible. */
export const PULSE_STAGGER_MS = 180;
/**
 * Max blocks to pulse individually before a silent resync. Mainnet settles
 * roughly every ~2s, so a normal 8s poll sees ~4; anything far above that
 * means the tab slept or the mirror was unreachable.
 */
export const PULSE_CATCH_UP_CAP = 8;

export interface PulsePlan {
  /** How many individual pulses to fire (0 = stay still). */
  pulses: number;
  /** True when we should adopt the latest block silently (baseline or big gap). */
  resync: boolean;
}

/**
 * Decide what to do when a poll observes `latest` after last seeing
 * `lastSeen`. Pure — every branch is unit-tested.
 */
export function planBlockPulses(
  lastSeen: number | null,
  latest: number,
  cap: number = PULSE_CATCH_UP_CAP,
): PulsePlan {
  // No baseline yet: adopt silently, never pulse for history.
  if (lastSeen === null) return { pulses: 0, resync: true };
  // Same block, or the mirror moved backwards: nothing new, stay still.
  if (latest <= lastSeen) return { pulses: 0, resync: false };
  const gap = latest - lastSeen;
  // Small gap: one pulse per block — never merged into a single pulse.
  if (gap <= cap) return { pulses: gap, resync: false };
  // Large gap (slept tab, long outage): silent resync. We don't claim
  // motion for blocks we never observed.
  return { pulses: 0, resync: true };
}

/**
 * Extract the latest block number from a mirror /api/v1/blocks response.
 * Returns null for any malformed/unexpected shape — the caller treats
 * that as a mirror error and goes silent. A missing or malformed
 * timestamp does NOT fail this: the block number alone is enough to
 * drive the pulse; only the "Xs ago" freshness readout needs the time.
 */
export function parseLatestBlock(data: unknown): number | null {
  const first = firstBlock(data);
  return first === null ? null : parseBlockNumber(first);
}

/** Latest block number plus its consensus timestamp (ms since epoch). */
export interface BlockInfo {
  number: number;
  /** Consensus time of the block, milliseconds since epoch. */
  timestampMs: number;
}

function firstBlock(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const blocks = (data as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const first = blocks[0];
  return first && typeof first === "object"
    ? (first as Record<string, unknown>)
    : null;
}

function parseBlockNumber(first: Record<string, unknown>): number | null {
  const number = first["number"];
  if (typeof number !== "number" || !Number.isInteger(number) || number < 0) {
    return null;
  }
  return number;
}

/**
 * Parse a mirror "seconds.nanoseconds" timestamp to whole milliseconds,
 * exactly: whole seconds plus the first three fractional digits (padded
 * to three). Never parseFloat on the full string — the float rounds the
 * trailing digits, which corrupts exact-string pagination cursors.
 * (Callers must keep the raw string for cursors; this ms value is only
 * for human freshness readouts.)
 */
export function parseMirrorTimestampMs(tsString: string): number {
  const [secPart, fracPart = ""] = tsString.split(".");
  const seconds = Number(secPart);
  if (!Number.isFinite(seconds) || seconds <= 0) return NaN;
  const millis = Number((fracPart + "000").slice(0, 3));
  if (!Number.isFinite(millis)) return NaN;
  return seconds * 1000 + millis;
}

/**
 * Extract the latest block number AND its consensus timestamp from a
 * mirror /api/v1/blocks response. Returns null for any malformed shape,
 * INCLUDING a missing or malformed timestamp — the timestamp powers the
 * human "Xs ago" freshness readout, which must never guess.
 * The timestamp powers the human "Xs ago" freshness readout — a human
 * feels "this is live right now" from recency, not from a raw number.
 */
export function parseLatestBlockInfo(data: unknown): BlockInfo | null {
  const first = firstBlock(data);
  if (first === null) return null;
  const number = parseBlockNumber(first);
  if (number === null) return null;
  // Mirror /blocks entries carry timestamp as { from, to } where each is
  // "seconds.nanoseconds" (e.g. "1727457600.123456789"). Use `from` —
  // when the block opened — as the human freshness anchor.
  const rawTs = first["timestamp"];
  const tsString =
    typeof rawTs === "string"
      ? rawTs
      : typeof rawTs === "object" && rawTs !== null
        ? (rawTs as { from?: unknown }).from
        : undefined;
  if (typeof tsString !== "string") return null;
  const timestampMs = parseMirrorTimestampMs(tsString);
  if (!Number.isFinite(timestampMs)) return null;
  return { number, timestampMs };
}

/**
 * Human freshness readout for a block timestamp: "3s", "45s", "2m".
 * Pure — unit-tested. Never claims the future: a timestamp ahead of now
 * (clock skew) reads "0s", not a negative.
 */
export function formatBlockAgo(timestampMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - timestampMs);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

/**
 * Comma-grouped block number for humans: 100458020 -> "100,458,020".
 * Pure — unit-tested.
 */
export function formatBlockNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/* ------------------------------------------------------------------ */
/* Vision "alive" feed helpers — pure, unit-tested                      */
/* ------------------------------------------------------------------ */

/** Registry contract event topic0 hashes (canonical Solidity signatures). */
export const PAGE_REGISTERED_TOPIC0 =
  "0xa327fd868734b8d16f5a1b2685a76b5cce3891a78c46bc724e7eb68ddd7917eb";
export const PAGE_UPDATED_TOPIC0 =
  "0xa4c1ea4f124910234beaa5e008aa404b64055531a6b524c62412b032f35596f3";
/** VoicescapeTips PurchaseCompleted(address,address,string,uint256,uint256). */
export const PURCHASE_COMPLETED_TOPIC0 =
  "0x8555727c6813e10ae0b5a9b0a53a88a93176679845f5a005a248cdb9f1c05f2e";

/**
 * Whale threshold: a single transfer leg of >= 100,000 HBAR, in tinybar.
 * Real mainnet traffic in a 100-tx window tops out in the low hundreds of
 * HBAR, so this fires a few times a day at most — an event, not noise.
 */
export const WHALE_THRESHOLD_TINYBAR = 100_000 * 100_000_000;

/** Block number + transaction count + hash for the "what was in this block" popup. */
export interface BlockAnatomy {
  number: number;
  txCount: number;
  hash: string;
}

/** Extract block anatomy from a mirror /api/v1/blocks response. Null on
 *  any malformed shape — the popup stays honest instead of guessing. */
export function parseBlockAnatomy(data: unknown): BlockAnatomy | null {
  const first = firstBlock(data);
  if (first === null) return null;
  const number = parseBlockNumber(first);
  const count = first["count"];
  const hash = first["hash"];
  if (
    number === null ||
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 0 ||
    typeof hash !== "string" ||
    hash.length === 0
  ) {
    return null;
  }
  return { number, txCount: count, hash };
}

/** HBAR/USD from /api/v1/network/exchangerate. Null when malformed. */
export function hbarPriceUsd(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const rate = (data as { current_rate?: unknown }).current_rate;
  if (!rate || typeof rate !== "object") return null;
  const cent = (rate as { cent_equivalent?: unknown }).cent_equivalent;
  const hbar = (rate as { hbar_equivalent?: unknown }).hbar_equivalent;
  if (typeof cent !== "number" || typeof hbar !== "number" || hbar <= 0) {
    return null;
  }
  const price = cent / hbar / 100;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * Consensus-node city from the address-book description, e.g.
 * "Hosted by LG | Singapore" -> "Singapore". Null when no city part.
 */
export function parseNodeCity(description: unknown): string | null {
  if (typeof description !== "string") return null;
  const parts = description.split("|");
  const city = parts[parts.length - 1].trim();
  return city.length > 0 ? city : null;
}

/** Transfer legs at or above the whale threshold. Never throws. */
export function findWhaleLegs(
  transfers: unknown,
): { account: string; amount: number }[] {
  if (!Array.isArray(transfers)) return [];
  const out: { account: string; amount: number }[] = [];
  for (const t of transfers) {
    if (!t || typeof t !== "object") continue;
    const { account, amount } = t as { account?: unknown; amount?: unknown };
    if (typeof account !== "string" || typeof amount !== "number") continue;
    if (Math.abs(amount) >= WHALE_THRESHOLD_TINYBAR) {
      out.push({ account, amount });
    }
  }
  return out;
}

/**
 * Decode the whole-HBAR amount from a PurchaseCompleted log's data field.
 * Layout: offset(32) | amount uint256 | fee uint256 | string bytes.
 * Null when malformed — the feed row is skipped, never guessed.
 */
export function decodePurchaseAmountHbar(dataHex: unknown): number | null {
  if (typeof dataHex !== "string" || !dataHex.startsWith("0x")) return null;
  const hex = dataHex.slice(2);
  if (hex.length < 128 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  try {
    const amountTiny = BigInt("0x" + hex.slice(64, 128));
    const hbar = Number(amountTiny) / 100_000_000;
    return Number.isFinite(hbar) && hbar >= 0 ? hbar : null;
  } catch {
    return null;
  }
}

/** Feed "3m ago" readout from a ms timestamp. Never claims the future. */
export function formatFeedAgo(tsMs: number, nowMs: number): string {
  return `${formatBlockAgo(tsMs, nowMs)} ago`;
}

/** Shorten a 0x hash for display: 0xa37f…9ad2. */
export function shortHash(hash: string): string {
  if (typeof hash !== "string" || hash.length < 12) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

/* ------------------------------------------------------------------ */
/* Gossip layer — live "not a blockchain" visualization                */
/*                                                                     */
/* Every helper is pure: the browser shows real mirror-node data only.  */
/* Nothing here guesses. Anything malformed returns null / is skipped, */
/* so the constellation sits honestly quiet instead of rendering       */
/* simulated network activity.                                         */
/* ------------------------------------------------------------------ */

/**
 * Minimal shape of a mirror /api/v1/transactions row needed by the
 * gossip layer. Field `node` is the submitting consensus node's account
 * id (e.g. "0.0.38") — the real evidence of where each transaction
 * entered the gossip network.
 */
export interface GossipTx {
  transaction_id?: unknown;
  name?: unknown;
  node?: unknown;
  consensus_timestamp?: unknown;
  valid_start_timestamp?: unknown;
  transaction_hash?: unknown;
  transfers?: unknown;
  /** Network fee actually charged, in tinybars (verified live 2026-10-21). */
  charged_tx_fee?: unknown;
}

/**
 * String-guarded timestamp parse: malformed rows yield NaN, never a
 * throw. parseMirrorTimestampMs assumes a string; gossip rows arrive as
 * unknown-shaped mirror JSON.
 */
const gossipTsMs = (v: unknown): number =>
  typeof v === "string" ? parseMirrorTimestampMs(v) : NaN;

/**
 * That transaction's OWN finality time: consensus_timestamp minus
 * valid_start_timestamp, in seconds. Exact via parseMirrorTimestampMs.
 * Null for any malformed or non-positive interval — a ripple never
 * shows a guessed number.
 */
export function txFinalitySeconds(tx: GossipTx): number | null {
  if (!tx || typeof tx !== "object") return null;
  const c = gossipTsMs(tx.consensus_timestamp);
  const v = gossipTsMs(tx.valid_start_timestamp);
  if (!Number.isFinite(c) || !Number.isFinite(v)) return null;
  const s = (c - v) / 1000;
  return Number.isFinite(s) && s > 0 ? s : null;
}

/** Format a finality readout: 5.66 -> "5.7s". */
export function formatFinality(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

/**
 * Live TPS from a mirror transaction window (order=desc): (n-1) over the
 * consensus-timestamp span. Null when the span is zero or unusable —
 * the vitals line omits TPS rather than printing a guess.
 */
export function sampleTps(txs: GossipTx[]): number | null {
  if (!Array.isArray(txs) || txs.length < 2) return null;
  const newest = gossipTsMs(txs[0].consensus_timestamp);
  const oldest = gossipTsMs(txs[txs.length - 1].consensus_timestamp);
  if (!Number.isFinite(newest) || !Number.isFinite(oldest)) return null;
  const span = (newest - oldest) / 1000;
  if (!Number.isFinite(span) || span <= 0) return null;
  return (txs.length - 1) / span;
}

/**
 * Median finality of a transaction sample. Null when no tx in the sample
 * yields a valid finality — honest silence over a fake number.
 */
export function medianFinalitySeconds(txs: GossipTx[]): number | null {
  if (!Array.isArray(txs) || txs.length === 0) return null;
  const finals = txs
    .map(txFinalitySeconds)
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  if (finals.length === 0) return null;
  const mid = Math.floor(finals.length / 2);
  return finals.length % 2 === 1
    ? finals[mid]
    : (finals[mid - 1] + finals[mid]) / 2;
}

/**
 * Submitting-node account id -> consensus city, from the /api/v1/network/nodes
 * address book. Entries without a usable account id or city are skipped.
 */
export function nodeAccountToCity(
  nodes: { node_account_id?: unknown; description?: unknown }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(nodes)) return out;
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const acct =
      typeof n.node_account_id === "string" ? n.node_account_id : null;
    const city = parseNodeCity(n.description);
    if (acct && city) out[acct] = city;
  }
  return out;
}

/**
 * City -> transaction count for one gossip sample. Transactions whose
 * submitting node isn't in the address-book map are skipped (never
 * attributed to the wrong city).
 */
export function groupTxByCity(
  txs: GossipTx[],
  nodeCity: Record<string, string>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(txs)) return out;
  for (const t of txs) {
    if (!t || typeof t !== "object") continue;
    const city =
      typeof t.node === "string" ? nodeCity[t.node] : undefined;
    if (!city) continue;
    out.set(city, (out.get(city) ?? 0) + 1);
  }
  return out;
}

const GOSSIP_TX_ID = (t: GossipTx): string | null =>
  typeof t.transaction_id === "string" ? t.transaction_id : null;

/**
 * Pick hero transactions for the full ripple treatment: fresh
 * CRYPTOTRANSFER rows carrying real transfers first (value moved is
 * the most legible gossip story), then any other fresh transactions to
 * fill up to `count`. Never returns a tx without a valid finality —
 * the ripple's "FINAL · Xs" label must always be that tx's own number.
 */
export function selectHeroTxs(
  txs: GossipTx[],
  seenIds: Set<string>,
  count: number,
): GossipTx[] {
  if (!Array.isArray(txs) || count <= 0) return [];
  const fresh = txs.filter((t) => {
    if (!t || typeof t !== "object") return false;
    const id = GOSSIP_TX_ID(t);
    if (!id || seenIds.has(id)) return false;
    return txFinalitySeconds(t) !== null;
  });
  const withValue = fresh.filter(
    (t) =>
      t.name === "CRYPTOTRANSFER" &&
      Array.isArray(t.transfers) &&
      t.transfers.length > 0,
  );
  const rest = fresh.filter((t) => !withValue.includes(t));
  return [...withValue, ...rest].slice(0, count);
}

/* ------------------------------------------------------------------ */
/* Stream views — Lanes + Rain (Danny's Vision, Oct 2026)              */
/*                                                                     */
/* Both views render ONE rolling sample already collected by the       */
/* gossip poller — they never fetch, never simulate, and never         */
/* re-animate history. A transaction's type comes from the mirror's    */
/* own `name` field; anything unrecognised is "other", never guessed.  */
/* Fees come from `charged_tx_fee` (tinybars, verified live           */
/* 2026-10-21); a row without a numeric fee is excluded from fee       */
/* sums, never counted as zero in a way that would hide the gap.       */
/* ------------------------------------------------------------------ */

/** The five stream lanes, in display order. */
export type StreamType = "crypto" | "hcs" | "contract" | "file" | "other";

/** Mirror `name` -> stream lane. Unknown / malformed -> "other". */
export function classifyStreamType(name: unknown): StreamType {
  switch (name) {
    case "CRYPTOTRANSFER":
      return "crypto";
    case "CONSENSUSSUBMITMESSAGE":
      return "hcs";
    case "CONTRACTCALL":
      return "contract";
    case "FILEAPPEND":
      return "file";
    default:
      return "other";
  }
}

/** Minimal shape a stream sample row needs. */
export interface StreamSampleTx {
  name?: unknown;
  charged_tx_fee?: unknown;
  /** Consensus time, milliseconds since epoch. NaN / missing = skipped. */
  tsMs?: unknown;
}

export interface StreamTypeGroup {
  count: number;
  /** Sum of numeric charged fees in tinybars; feeCount rows contributed. */
  feesTinybars: number;
  feeCount: number;
}

/** Group a sample by lane. Rows with no usable name still count as other. */
export function groupStreamByType(
  txs: StreamSampleTx[],
): Record<StreamType, StreamTypeGroup> {
  const out: Record<StreamType, StreamTypeGroup> = {
    crypto: { count: 0, feesTinybars: 0, feeCount: 0 },
    hcs: { count: 0, feesTinybars: 0, feeCount: 0 },
    contract: { count: 0, feesTinybars: 0, feeCount: 0 },
    file: { count: 0, feesTinybars: 0, feeCount: 0 },
    other: { count: 0, feesTinybars: 0, feeCount: 0 },
  };
  if (!Array.isArray(txs)) return out;
  for (const t of txs) {
    if (!t || typeof t !== "object") continue;
    const g = out[classifyStreamType(t.name)];
    g.count += 1;
    if (typeof t.charged_tx_fee === "number" && Number.isFinite(t.charged_tx_fee)) {
      g.feesTinybars += t.charged_tx_fee;
      g.feeCount += 1;
    }
  }
  return out;
}

/** Consensus-time span of a sample in seconds. Null when <2 usable rows. */
export function streamSpanSeconds(txs: StreamSampleTx[]): number | null {
  if (!Array.isArray(txs)) return null;
  const times = txs
    .map((t) => (typeof t.tsMs === "number" ? t.tsMs : NaN))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (times.length < 2) return null;
  const span = (times[times.length - 1] - times[0]) / 1000;
  return Number.isFinite(span) && span > 0 ? span : null;
}

/** TPS over a sample: (n-1) over its consensus span. Null when unusable. */
export function streamTps(txs: StreamSampleTx[]): number | null {
  const span = streamSpanSeconds(txs);
  if (span === null) return null;
  const n = txs.filter(
    (t) => typeof t.tsMs === "number" && Number.isFinite(t.tsMs),
  ).length;
  if (n < 2) return null;
  return (n - 1) / span;
}

/**
 * Fee rate in HBAR per hour over the sample's own span — a windowed
 * extrapolation, never measured hourly revenue. Null when the span is
 * unusable or no row carries a numeric fee. Callers must label it with
 * its window ("last N tx") because short windows swing wildly.
 */
export function streamFeePerHourHbar(txs: StreamSampleTx[]): number | null {
  const span = streamSpanSeconds(txs);
  if (span === null) return null;
  let total = 0;
  let counted = 0;
  for (const t of txs) {
    if (!t || typeof t !== "object") continue;
    if (typeof t.charged_tx_fee === "number" && Number.isFinite(t.charged_tx_fee)) {
      total += t.charged_tx_fee;
      counted += 1;
    }
  }
  if (counted === 0) return null;
  return (total / 100_000_000) * (3600 / span);
}

/** Daily pace from a TPS figure: TPS x 86,400. A pace, never a forecast. */
export function dailyPaceTx(tps: number): number {
  return tps * 86_400;
}
