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
 * the video id only when the canonical link resolves to a watch URL.
 */
export function parseYouTubeLiveStatus(html: string): YouTubeLiveStatus {
  const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? "";
  const videoId = canonical.match(/[?&]v=([a-zA-Z0-9_-]{11})/)?.[1] ?? null;
  if (videoId && isYouTubeVideoId(videoId)) return { live: true, videoId };
  return { live: false, videoId: null };
}
