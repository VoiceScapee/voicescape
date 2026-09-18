/**
 * Badge/follower-weighted explore ranking.
 *
 * Brandon's directive (2026-09-16): "the more badges/followers a blockpage
 * has, the more visible it stays in the dapp."
 *
 * Signals are honest, real counts only — never invented:
 *   - followers: distinct wallets following the page (KV `followers:<username>`,
 *     via lib/follows `followerCount`). One cheap KV read per page.
 *   - badges: earned HCS-derived badges from the cached (5-min) town hall
 *     stats blob — activity, quality-social, milestone, and the referral
 *     ladder (Connector → Networker → Growth Engine → Viral). Computed with
 *     the same pure `badgesForUser` path the leaderboard uses.
 *
 * Deliberately excluded: wallet-enriched badges (tipped, builder, patron,
 * generous-tipper, …) — those need per-wallet Mirror Node payment queries
 * and are too expensive to compute per explore page. The count shown is the
 * HCS-derived subset, which is exactly what "earned badges" means here.
 *
 * score = followers + badges. Ties break by recency: every sort here is
 * stable, so callers pass pages newest-first and equal scores keep that
 * order. All IO lives in the route; everything here is pure and fail-open
 * (signal failure → 0, never throws).
 */

import {
  badgesForUser,
  EMPTY_ENRICHMENT,
  toStats,
  type TownhallStatsBlob,
} from "./townhall/badges";

export type { TownhallStatsBlob };

export type ExploreSort = "trending" | "new";

/** Parse ?sort= — anything unknown falls back to trending. */
export function parseExploreSort(v: string | null | undefined): ExploreSort {
  return v === "new" ? "new" : "trending";
}

/**
 * Real earned-badge count (HCS-derived subset) for a username from the
 * cached stats blob. 0 when the blob is missing or the user has no entry.
 *
 * Explore pages are on-chain registered by construction, so `ownsPage` is
 * set on the enrichment (currently a no-op without tipsReceived, but
 * semantically accurate). Wallet-enriched badges (tipped, builder,
 * patron, …) stay excluded — they need per-wallet Mirror Node queries.
 */
export function badgeCountFor(
  blob: TownhallStatsBlob | null | undefined,
  username: string,
): number {
  if (!blob) return 0;
  const entry = blob.users[username.trim().toLowerCase()];
  if (!entry) return 0;
  const enrichment = { ...EMPTY_ENRICHMENT, ownsPage: true };
  return badgesForUser(toStats(entry), enrichment, null).length;
}

/** Ranking score: followers + badges. Negative inputs clamp to 0. */
export function scorePage(followers: number, badges: number): number {
  return Math.max(0, followers) + Math.max(0, badges);
}

export interface RankSignals {
  followers: number;
  badges: number;
}

export type ScoredPage<T> = T & RankSignals & { score: number };

/**
 * Attach signals + score to each page. Pure — the caller supplies signals
 * (built via KV/HCS in the route). Never throws for missing signals.
 */
export function attachScores<T extends { username: string }>(
  pages: T[],
  getSignals: (username: string) => RankSignals | undefined,
): ScoredPage<T>[] {
  return pages.map((p) => {
    const s = getSignals(p.username) ?? { followers: 0, badges: 0 };
    const followers = Math.max(0, s.followers);
    const badges = Math.max(0, s.badges);
    return { ...p, followers, badges, score: followers + badges };
  });
}

/**
 * Sort by score descending. Stable — ties keep the input order, so pass
 * pages newest-first and equal scores break by recency.
 */
export function sortTrending<T>(scored: ScoredPage<T>[]): ScoredPage<T>[] {
  return [...scored].sort((a, b) => b.score - a.score);
}
