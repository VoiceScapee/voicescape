/**
 * Video block URL handling (webseries blocks).
 *
 * Pure and dependency-free: parses a pasted video URL into a playable
 * form, or null when the URL is not a video we can play in-page.
 *
 * Allowed sources (allowlist — anything else is rejected, never rendered):
 * - YouTube watch / youtu.be / embed / shorts links (privacy-enhanced
 *   youtube-nocookie embeds, the same player the music block uses).
 * - Direct .mp4 files from the Reel24 media bucket
 *   (storage.googleapis.com/reel24-media/…) and the Reel24 site itself
 *   (thevisualxperience.com) — the Town Hall film lives there.
 *
 * HLS (.m3u8) is deliberately NOT supported: a bare <video> element
 * cannot play HLS in every browser, and pulling in an HLS player library
 * for one film is not worth it — the MP4 serves the same file.
 */

export type ParsedVideo =
  | { kind: "youtube"; id: string }
  | { kind: "mp4"; url: string };

const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,16}$/;

/** Extract a YouTube video id from a watch / short / embed / shorts URL. */
function parseYouTube(input: string): { kind: "youtube"; id: string } | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    // /watch?v=ID, /embed/ID, /shorts/ID
    const v = url.searchParams.get("v");
    if (url.pathname === "/watch" && v && YOUTUBE_ID.test(v)) return { kind: "youtube", id: v };
    const m = url.pathname.match(/^\/(?:embed|shorts)\/([A-Za-z0-9_-]{6,16})/);
    if (m) return { kind: "youtube", id: m[1] };
    return null;
  }
  if (host === "youtu.be") {
    const id = url.pathname.replace(/^\/+/, "").split("/")[0];
    if (id && YOUTUBE_ID.test(id)) return { kind: "youtube", id };
    return null;
  }
  return null;
}

/**
 * Direct .mp4 files from the Reel24 media bucket or the Reel24 site.
 * The host allowlist is exact — a lookalike subdomain does not pass.
 * Query strings (e.g. Reel24's ?v= cache-buster) are kept.
 */
function parseMp4(input: string): { kind: "mp4"; url: string } | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  const isReel24Bucket =
    host === "storage.googleapis.com" && url.pathname.startsWith("/reel24-media/");
  const isReel24Site = host === "thevisualxperience.com" || host === "www.thevisualxperience.com";
  if (!isReel24Bucket && !isReel24Site) return null;
  if (!url.pathname.toLowerCase().endsWith(".mp4")) return null;
  return { kind: "mp4", url: input.trim() };
}

/** Parse a pasted video URL into a playable form, or null when unplayable. */
export function parseVideoUrl(raw: unknown): ParsedVideo | null {
  if (typeof raw !== "string") return null;
  const input = raw.trim();
  if (!input) return null;
  return parseYouTube(input) ?? parseMp4(input) ?? null;
}

/**
 * Player URL for a parsed video: the youtube-nocookie embed for YouTube,
 * the MP4 itself for direct files.
 */
export function videoEmbedUrl(parsed: ParsedVideo): string {
  if (parsed.kind === "youtube") {
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(parsed.id)}?rel=0`;
  }
  return parsed.url;
}
