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
