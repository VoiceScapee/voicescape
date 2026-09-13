import { NextRequest, NextResponse } from "next/server";
import { checkIpRateLimit, clientIpFromHeaders, ipRateLimitFromEnv } from "@/lib/server/rate-limit";
import { parseRssItems, type PulseItem } from "@/lib/server/rss";
import { CURATED_VIDEOS } from "@/lib/landing/videos";

export const runtime = "nodejs";

/**
 * GET /api/pulse → { updatedAt, items: [{title, url, date, source, kind, thumb}] }
 *
 * Community-pulse content for the landing page:
 *   - featured video clips: curated official Hedera YouTube videos
 *     (titles verified live 2026-09-13; the channel feed needs a confirmed
 *     channel_id, so this is an honest curated set — see lib/landing/videos.ts)
 *   - headlines: two equal lanes — Hedera (official blog) and global crypto
 *     (CoinDesk, Cointelegraph, Decrypt, The Block) — fetched server-side and
 *     cached for one hour ($0 — plain RSS, no news API, no keys). Equal
 *     per-lane quotas keep the mix 50/50; lanes interleave so the balance
 *     holds no matter which side published most recently. Refreshes hourly
 *     server-side (stale-while-revalidate) and every 15 minutes client-side,
 *     so topics stay current as the news cycle moves.
 * Session-less read.
 *
 * Fail-open by design: a dead feed, a parse failure, or a rate-limit hit
 * returns the last cached items (or an empty list) with 200 — the landing
 * page hides the headlines section when there is nothing to show.
 */

type Lane = "hedera" | "crypto";

const FEEDS: { name: string; url: string; lane: Lane }[] = [
  { name: "Hedera Blog", url: "https://hedera.com/blog/rss.xml", lane: "hedera" },
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss", lane: "crypto" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss", lane: "crypto" },
  { name: "Decrypt", url: "https://decrypt.co/feed", lane: "crypto" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml", lane: "crypto" },
  // Video clips: add the official Hedera YouTube channel feed here once its
  // channel_id is confirmed:
  //   https://www.youtube.com/feeds/videos.xml?channel_id=<ID>
  // The parser already handles Atom + thumbnails (kind: "video").
];

const CACHE_TTL_MS = 3_600_000; // 1 hour
const FETCH_TIMEOUT_MS = 8_000;
const PER_SOURCE_MAX = 4; // fetch enough per outlet to fill its lane
const PER_LANE_MAX = 4; // equal amounts: up to 4 Hedera + 4 global crypto

interface CacheEntry {
  at: number;
  items: PulseItem[];
  refreshing: boolean;
}

const cache: CacheEntry = { at: 0, items: [], refreshing: false };

async function fetchFeed(name: string, url: string): Promise<PulseItem[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "user-agent": "VoicescapePulse/1.0 (+https://voicescape.vercel.app)",
        accept: "application/rss+xml, application/xml, text/xml",
      },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssItems(xml, name, PER_SOURCE_MAX);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function byDateDesc(a: PulseItem, b: PulseItem): number {
  if (a.date && b.date) return b.date.localeCompare(a.date);
  if (a.date) return -1;
  if (b.date) return 1;
  return 0;
}

async function refreshCache(): Promise<void> {
  if (cache.refreshing) return;
  cache.refreshing = true;
  try {
    const lanes: Record<Lane, Map<string, PulseItem[]>> = {
      hedera: new Map(),
      crypto: new Map(),
    };
    for (const feed of FEEDS) {
      const items = (await fetchFeed(feed.name, feed.url)).sort(byDateDesc);
      const bySource = lanes[feed.lane];
      bySource.set(feed.name, [...(bySource.get(feed.name) ?? []), ...items]);
    }
    // Round-robin within each lane (rank 0 from every outlet, then rank 1…)
    // so no single outlet dominates its lane, then cap each lane equally —
    // the mix stays 50/50 even when one side publishes far more often.
    const capped = (Object.keys(lanes) as Lane[]).map((lane) => {
      const groups = [...lanes[lane].values()];
      const out: PulseItem[] = [];
      const longest = Math.max(0, ...groups.map((g) => g.length));
      for (let i = 0; i < longest && out.length < PER_LANE_MAX; i++) {
        for (const g of groups) {
          if (g[i] && out.length < PER_LANE_MAX) out.push(g[i]);
        }
      }
      return out;
    });
    // Interleave lanes so the on-screen balance holds at any slice length.
    const articles: PulseItem[] = [];
    const longest = Math.max(...capped.map((l) => l.length));
    for (let i = 0; i < longest; i++) {
      for (const lane of capped) {
        if (lane[i]) articles.push(lane[i]);
      }
    }
    // Featured clips are static and always available; headlines are
    // best-effort. Merge unconditionally so a dead feed never hides the
    // videos that Brandon asked for.
    cache.items = [...CURATED_VIDEOS, ...articles];
    // Always stamp the attempt: a dead feed on cold start must not make
    // every request wait on a failing fetch. Stale items beat empty.
    cache.at = Date.now();
  } finally {
    cache.refreshing = false;
  }
}

export async function GET(req: NextRequest) {
  // Generous fail-open rate limit: headlines must survive traffic spikes.
  try {
    const res = await checkIpRateLimit(
      clientIpFromHeaders(req.headers),
      "pulse",
      ipRateLimitFromEnv("IP_RATE_LIMIT_PULSE", 120),
      3_600_000,
    );
    if (!res.allowed) {
      return NextResponse.json({
        updatedAt: cache.at ? new Date(cache.at).toISOString() : null,
        items: cache.items,
      });
    }
  } catch {
    /* store unreachable — serve cache below (best-effort) */
  }

  const stale = Date.now() - cache.at > CACHE_TTL_MS;
  if (stale && !cache.refreshing) {
    if (cache.items.length === 0) {
      // Cold start: wait for the first fetch so the section has content.
      await refreshCache();
    } else {
      // Warm: serve stale immediately, refresh in the background.
      void refreshCache();
    }
  }
  return NextResponse.json({
    updatedAt: cache.at ? new Date(cache.at).toISOString() : null,
    items: cache.items,
  });
}
