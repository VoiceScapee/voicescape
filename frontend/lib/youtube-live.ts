/**
 * YouTube live-status helpers.
 *
 * Live detection for YouTube channels is done server-side against the
 * channel's public /live page: when the channel is live, YouTube serves HTML
 * whose canonical link points at the live video
 * (<link rel="canonical" href="https://www.youtube.com/watch?v=...">);
 * when offline, the canonical link points back at the channel page itself.
 * No API key, no quota, no client JS bridge — the old approach (watching the
 * live_stream?channel= embed for a PLAYING event through the IFrame API)
 * proved unreliable, so the LIVE badge and chat are driven by this signal
 * instead. Offline-first: any parse or fetch failure means "not live".
 */

export interface YouTubeLiveStatus {
  live: boolean;
  videoId: string | null;
}

/** Channel IDs look like UC + 22 base64url chars. */
export function isYouTubeChannelId(value: string): boolean {
  return /^UC[a-zA-Z0-9_-]{22}$/.test(value);
}

/** YouTube video IDs are 11 base64url chars. */
export function isYouTubeVideoId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test(value);
}

/**
 * Parse a youtube.com/channel/<id>/live HTML page. Returns live:true plus
 * the video id only when the page provably resolves to a live video.
 *
 * Two signals, strongest first:
 * 1. Canonical link -> watch?v=<id>. Present on full desktop page variants.
 * 2. Embedded watch data. YouTube serves several HTML variants of /live
 *    (desktop, mobile, degraded/bot-suspect); some carry no usable canonical
 *    link. But when the channel is live, every variant embeds the live
 *    video's watch-page JSON, which contains "isLive":true (exactly once,
 *    for the primary video), and the primary video is the most-referenced
 *    videoId on the page. The "isLive":true gate keeps this honest: without
 *    it we never claim live, no matter how many videoIds appear.
 */
export function parseYouTubeLiveStatus(html: string): YouTubeLiveStatus {
  const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? "";
  const fromCanonical = canonical.match(/[?&]v=([a-zA-Z0-9_-]{11})/)?.[1];
  if (fromCanonical && isYouTubeVideoId(fromCanonical)) {
    return { live: true, videoId: fromCanonical };
  }

  if (/"isLive":true/.test(html)) {
    const counts = new Map<string, number>();
    for (const m of html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)) {
      const id = m[1];
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [id, n] of counts) {
      if (n > bestN) {
        best = id;
        bestN = n;
      }
    }
    // Small margin so a thin/partial page can't crown a related video.
    if (best && isYouTubeVideoId(best) && bestN >= 3) {
      return { live: true, videoId: best };
    }
  }

  return { live: false, videoId: null };
}
