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
 * that as a mirror error and goes silent.
 */
export function parseLatestBlock(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const blocks = (data as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const number = (blocks[0] as { number?: unknown })?.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 0) {
    return null;
  }
  return number;
}
