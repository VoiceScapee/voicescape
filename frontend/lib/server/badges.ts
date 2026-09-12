/**
 * Voicescape Builder Badge — gates the builders-only Town Hall room.
 *
 * A wallet earns the Builder badge by proving on-platform work:
 *   1. Published a blockpage (owns a username registered in the Registry
 *      contract), AND
 *   2. Received at least 1 tip (Tips contract shows an incoming payment).
 *
 * Both signals are read-only Mirror Node queries against the existing
 * mainnet contracts — no new contracts, no writes, no platform spend.
 * Results are cached in KV for 1 hour.
 */

import { canonicalAddress } from "../session-message";
import { getKvStore } from "./store";
import { countPaymentsReceived, ownsRegisteredPage } from "./townhall/badges";

/** Reserved chat room id for the builders-only Town Hall room. */
export const BUILDERS_ROOM_ID = "builders";

/** Shown when a wallet without the Builder badge tries to enter/post. */
export const BUILDER_UNLOCK_MESSAGE =
  "The Builders room is for Builder badge holders — publish a blockpage and receive your first tip to unlock it.";

const BADGE_CACHE_KEY_PREFIX = "vs:badges:builder:";
const BADGE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — badge status changes slowly

export interface BuilderBadgeProgress {
  /** Wallet owns at least one registered blockpage. */
  hasPage: boolean;
  /** Wallet received at least one on-chain tip/sale. */
  hasTip: boolean;
  /** Both goals complete — the Builder badge is earned. */
  complete: boolean;
}

const LOCKED_PROGRESS: BuilderBadgeProgress = { hasPage: false, hasTip: false, complete: false };

/**
 * Builder-badge progress for a wallet (0x or 0.0.x form). Fail-open:
 * Mirror Node or KV failures return locked progress, never a grant.
 */
export async function builderBadgeProgress(walletAddress: string): Promise<BuilderBadgeProgress> {
  const canon = canonicalAddress(walletAddress);
  if (!canon) return LOCKED_PROGRESS;
  const kv = getKvStore();
  const key = BADGE_CACHE_KEY_PREFIX + canon;
  try {
    const raw = await kv.get(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BuilderBadgeProgress>;
      return {
        hasPage: parsed.hasPage === true,
        hasTip: parsed.hasTip === true,
        complete: parsed.hasPage === true && parsed.hasTip === true,
      };
    }
  } catch {
    /* cache miss / corrupt / backend down → recompute */
  }
  const [hasPage, tips] = await Promise.all([
    ownsRegisteredPage(canon),
    countPaymentsReceived(canon),
  ]);
  const progress: BuilderBadgeProgress = {
    hasPage,
    hasTip: tips >= 1,
    complete: hasPage && tips >= 1,
  };
  try {
    await kv.set(key, JSON.stringify(progress), BADGE_CACHE_TTL_MS);
  } catch {
    /* fail-open: serve the fresh result without caching */
  }
  return progress;
}

/** True when the wallet has earned the Builder badge. */
export async function hasBuilderBadge(walletAddress: string): Promise<boolean> {
  return (await builderBadgeProgress(walletAddress)).complete;
}

/** Test helper: clear one wallet's cached badge progress. */
export async function clearBuilderBadgeCache(walletAddress: string): Promise<void> {
  const canon = canonicalAddress(walletAddress);
  if (!canon) return;
  try {
    await getKvStore().del(BADGE_CACHE_KEY_PREFIX + canon);
  } catch {
    /* best effort */
  }
}
