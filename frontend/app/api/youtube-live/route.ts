import { NextResponse } from "next/server";
import { isYouTubeChannelId, parseYouTubeLiveStatus } from "@/lib/youtube-live";

/**
 * GET /api/youtube-live?channel=UC...
 * Public, read-only live check for a YouTube channel. Fetches the channel's
 * public /live page server-side and reports whether it resolves to a live
 * video (canonical link -> watch?v=...). 60s per-channel cache; no API key.
 * Offline-first: any failure returns { live: false } — never a raw error.
 * ?debug=1 adds fetch metadata (status, final URL, byte size, canonical
 * href) for diagnosing server-side fetches.
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
// Desktop UA: the mobile UA gets 302'd to m.youtube.com, whose lighter page
// omits the live signals. The desktop page carries canonical -> watch?v=
// plus embedded "isLive":true watch data.
// Pre-consented cookie so YouTube serves the real page instead of a consent
// interstitial to server-side fetches. Public, non-secret value.
const CONSENT_COOKIE = "CONSENT=YES+cb.20210328-17-p0.en+FX+119";
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; body: unknown }>();

export async function GET(req: Request) {
  const url = new URL(req.url);
  const channel = url.searchParams.get("channel") ?? "";
  const debugMode = url.searchParams.get("debug") === "1";
  if (!isYouTubeChannelId(channel)) {
    return NextResponse.json({ ok: false, error: "bad channel" }, { status: 400 });
  }

  const now = Date.now();
  if (!debugMode) {
    const hit = cache.get(channel);
    if (hit && now - hit.at < CACHE_TTL_MS) return NextResponse.json(hit.body);
  }

  let body: unknown = { ok: true, live: false, videoId: null };
  const dbg = {
    status: 0,
    finalUrl: "",
    bytes: 0,
    canonical: "",
    isLiveFound: false,
    topVideoId: null as string | null,
    topVideoRefs: 0,
    error: null as string | null,
  };
  try {
    const res = await fetch(`https://www.youtube.com/channel/${channel}/live`, {
      headers: {
        "user-agent": UA,
        "accept-language": "en-US,en;q=0.9",
        cookie: CONSENT_COOKIE,
      },
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    dbg.status = res.status;
    dbg.finalUrl = res.url;
    const html = await res.text();
    dbg.bytes = html.length;
    dbg.canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? "";
    dbg.isLiveFound = /"isLive":true/.test(html);
    const counts = new Map<string, number>();
    for (const m of html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    for (const [id, n] of counts) {
      if (n > dbg.topVideoRefs) {
        dbg.topVideoId = id;
        dbg.topVideoRefs = n;
      }
    }
    const { live, videoId } = parseYouTubeLiveStatus(html);
    body = { ok: true, live, videoId };
  } catch (e) {
    dbg.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    // Offline-first: unknown means not live. Never leak a platform error.
  }
  if (debugMode) {
    body = { ...(body as Record<string, unknown>), debug: dbg };
  } else {
    cache.set(channel, { at: now, body });
  }
  return NextResponse.json(body);
}
