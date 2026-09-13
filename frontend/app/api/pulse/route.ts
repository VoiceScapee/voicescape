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
 *   - headlines: latest posts from the official Hedera blog RSS feed,
 *     fetched server-side and cached for one hour ($0 — no news API, no keys).
 * Session-less read.
 *
 * Fail-open by design: a dead feed, a parse failure, or a rate-limit hit
 * returns the last cached items (or an empty list) with 200 — the landing
 * page hides the headlines section when there is nothing to show.
 */

const FEEDS: { name: string; url: string }[] = [
  { name: "Hedera Blog", url: "https://hedera.com/blog/rss.xml" },
  // Video clips: add the official Hedera YouTube channel feed here once its
  // channel_id is confirmed:
  //   https://www.youtube.com/feeds/videos.xml?channel_id=<ID>
  // The parser already handles Atom + thumbnails (kind: "video").
];

const CACHE_TTL_MS = 3_600_000; // 1 hour
const FETCH_TIMEOUT_MS = 8_000;
const MAX_ITEMS = 8;

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
    return parseRssItems(xml, name, MAX_ITEMS);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function refreshCache(): Promise<void> {
  if (cache.refreshing) return;
  cache.refreshing = true;
  try {
    const all: PulseItem[] = [];
    for (const feed of FEEDS) {
      const items = await fetchFeed(feed.name, feed.url);
      all.push(...items);
    }
    all.sort((a, b) => {
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });
    // Featured clips are static and always available; headlines are
    // best-effort. Merge unconditionally so a dead feed never hides the
    // videos that Brandon asked for.
    cache.items = [...CURATED_VIDEOS, ...all].slice(0, MAX_ITEMS + CURATED_VIDEOS.length);
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
