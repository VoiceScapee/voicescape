import { NextResponse } from "next/server";
import {
  REGISTER_PAGE_SELECTOR,
  REGISTRY_ID,
  TIPS_ID,
  countSuccessfulResults,
} from "@/lib/server/chain-stats";

export const runtime = "nodejs";

/**
 * GET /api/chain/stats → { pages: number|null, tips: number|null }
 *
 * Live community-pulse numbers for the landing page, read straight from the
 * official Hedera mainnet mirror node (proven Hedera-native path) — see
 * lib/server/chain-stats.ts for the counting logic.
 *
 * 15-minute module-level in-memory cache ($0; mirrors tolerate this read
 * rate easily). Fail-soft by design: ANY error (network, HTTP, parse,
 * timeout) returns 200 { pages: null, tips: null } — never a 500 — so the
 * landing page hides the stat strip instead of showing invented numbers.
 * When a stale cache entry exists and a refresh fails, the stale entry
 * ships rather than nulls.
 */

const CACHE_TTL_MS = 15 * 60_000; // 15 minutes

interface StatsPayload {
  pages: number | null;
  tips: number | null;
}

let cache: { at: number; data: StatsPayload } | null = null;
let inFlight: Promise<StatsPayload> | null = null;

async function refreshStats(): Promise<StatsPayload> {
  // Single-flight: concurrent requests share one mirror-node sweep.
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const [pages, tips] = await Promise.all([
          countSuccessfulResults(fetch, REGISTRY_ID, REGISTER_PAGE_SELECTOR),
          countSuccessfulResults(fetch, TIPS_ID, null),
        ]);
        return { pages, tips };
      } finally {
        inFlight = null;
      }
    })();
  }
  return inFlight;
}

export async function GET() {
  const fresh = cache && Date.now() - cache.at < CACHE_TTL_MS;
  if (fresh && cache) return NextResponse.json(cache.data);
  try {
    const data = await refreshStats();
    cache = { at: Date.now(), data };
    return NextResponse.json(data);
  } catch {
    // Fail-soft: stale numbers beat fake ones; nulls beat crashing.
    if (cache) return NextResponse.json(cache.data);
    return NextResponse.json({ pages: null, tips: null });
  }
}
