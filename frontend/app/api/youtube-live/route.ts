import { NextResponse } from "next/server";
import { isYouTubeChannelId, parseYouTubeLiveStatus } from "@/lib/youtube-live";

/**
 * GET /api/youtube-live?channel=UC...
 * Public, read-only live check for a YouTube channel. Fetches the channel's
 * public /live page server-side and reports whether it resolves to a live
 * video (canonical link -> watch?v=...). 60s per-channel cache; no API key.
 * Offline-first: any failure returns { live: false } — never a raw error.
 */
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; body: unknown }>();

export async function GET(req: Request) {
  const channel = new URL(req.url).searchParams.get("channel") ?? "";
  if (!isYouTubeChannelId(channel)) {
    return NextResponse.json({ ok: false, error: "bad channel" }, { status: 400 });
  }

  const now = Date.now();
  const hit = cache.get(channel);
  if (hit && now - hit.at < CACHE_TTL_MS) return NextResponse.json(hit.body);

  let body: unknown = { ok: true, live: false, videoId: null };
  try {
    const res = await fetch(`https://www.youtube.com/channel/${channel}/live`, {
      headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" },
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const html = await res.text();
    const { live, videoId } = parseYouTubeLiveStatus(html);
    body = { ok: true, live, videoId };
  } catch {
    // Offline-first: unknown means not live. Never leak a platform error.
  }
  cache.set(channel, { at: now, body });
  return NextResponse.json(body);
}
