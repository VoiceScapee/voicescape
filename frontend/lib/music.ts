/**
 * Music block logic — canonical home for URL parsing and embed building.
 *
 * Pure TypeScript, no framework or DOM dependencies, so it can be imported
 * from the browser (builder, renderer helpers) and from Node (tests).
 *
 * Copyright posture: playback always goes through the platform's own embed
 * player (Spotify / YouTube / SoundCloud hold the licenses) or the page
 * owner's own IPFS upload. We never proxy or re-host third-party audio.
 */
import type { MusicSource, MusicTrack } from "./schema";

export const MUSIC_SOURCES: readonly MusicSource[] = [
  "spotify",
  "youtube",
  "soundcloud",
  "ipfs",
];

export const MUSIC_SOURCE_LABELS: Record<MusicSource, string> = {
  spotify: "Spotify",
  youtube: "YouTube",
  soundcloud: "SoundCloud",
  ipfs: "My upload",
};

const SPOTIFY_KINDS = new Set(["track", "album", "playlist", "episode", "artist"]);
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

function cleanId(raw: string): string {
  return raw.split(/[?#]/)[0].replace(/^\/+|\/+$/g, "");
}

/** Parse a Spotify link or spotify: URI. */
function parseSpotify(input: string, originalUrl?: string): MusicTrack | null {
  // spotify:track:xxxx URIs (from "copy Spotify URI")
  const uriMatch = /^spotify:(track|album|playlist|episode|artist):([A-Za-z0-9]+)$/.exec(
    input.trim(),
  );
  if (uriMatch) {
    return {
      source: "spotify",
      kind: uriMatch[1],
      id: uriMatch[2],
      url: originalUrl ?? input.trim(),
    };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "open.spotify.com" && host !== "play.spotify.com") return null;
  const segs = url.pathname.split("/").filter(Boolean);
  if (segs.length < 2 || !SPOTIFY_KINDS.has(segs[0])) return null;
  const id = cleanId(segs[1]);
  if (!id) return null;
  return { source: "spotify", kind: segs[0], id, url: originalUrl ?? input.trim() };
}

/** Parse a YouTube / youtu.be link (video, shorts, embed, or playlist). */
function parseYouTube(input: string, originalUrl?: string): MusicTrack | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host) && !YOUTUBE_HOSTS.has(host.replace(/^www\./, ""))) return null;
  const trimmed = input.trim();

  // Playlist-only link: ?list=xxx with no video id.
  const list = url.searchParams.get("list");
  const v = url.searchParams.get("v");
  const segs = url.pathname.split("/").filter(Boolean);

  if (host.includes("youtu.be")) {
    const id = cleanId(segs[0] ?? "");
    if (!id) return null;
    return { source: "youtube", kind: "video", id, url: originalUrl ?? trimmed };
  }
  if (v) {
    return { source: "youtube", kind: "video", id: cleanId(v), url: originalUrl ?? trimmed };
  }
  if (segs[0] === "embed" || segs[0] === "shorts" || segs[0] === "v" || segs[0] === "live") {
    const id = cleanId(segs[1] ?? "");
    if (!id) return null;
    return { source: "youtube", kind: "video", id, url: originalUrl ?? trimmed };
  }
  if (list && (segs[0] === "playlist" || url.pathname === "/watch")) {
    return { source: "youtube", kind: "playlist", id: cleanId(list), url: originalUrl ?? trimmed };
  }
  return null;
}

/** Parse a soundcloud.com artist/track (or artist/sets/playlist) link. */
function parseSoundCloud(input: string, originalUrl?: string): MusicTrack | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  // on.soundcloud.com short links need a redirect resolve — out of scope.
  if (host !== "soundcloud.com") return null;
  const path = cleanId(url.pathname);
  if (!path || path.split("/").length < 2) return null;
  const kind = path.includes("/sets/") ? "playlist" : "track";
  return { source: "soundcloud", kind, id: path, url: originalUrl ?? input.trim() };
}

/**
 * Parse a pasted music link into a MusicTrack.
 * Supports Spotify (links + spotify: URIs), YouTube (watch, youtu.be,
 * embed, shorts, playlists), and SoundCloud track/set links.
 * Returns null when the platform or ID can't be detected.
 */
export function parseMusicUrl(raw: string): MusicTrack | null {
  const input = (raw ?? "").trim();
  if (!input) return null;
  return (
    parseSpotify(input) ?? parseYouTube(input) ?? parseSoundCloud(input) ?? null
  );
}

/**
 * Build the player/embed URL for a track.
 * Returns null for "ipfs" tracks — those play through a native <audio>
 * element pointed at the IPFS gateway (see audioGatewayUrl in lib/ipfs).
 */
export function trackEmbedUrl(track: MusicTrack): string | null {
  switch (track.source) {
    case "spotify": {
      const kind = track.kind && SPOTIFY_KINDS.has(track.kind) ? track.kind : "track";
      return `https://open.spotify.com/embed/${kind}/${encodeURIComponent(track.id)}?utm_source=generator`;
    }
    case "youtube": {
      if (track.kind === "playlist") {
        return `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(track.id)}`;
      }
      return `https://www.youtube.com/embed/${encodeURIComponent(track.id)}?rel=0`;
    }
    case "soundcloud": {
      const pageUrl = encodeURIComponent(`https://soundcloud.com/${track.id}`);
      return `https://w.soundcloud.com/player/?url=${pageUrl}&color=%237c3aed&auto_play=false&visual=true`;
    }
    case "ipfs":
      return null;
  }
}

/**
 * "Open in app" URL for a track — the original pasted link when we have it,
 * otherwise a canonical platform URL reconstructed from the ID.
 */
export function trackOpenUrl(track: MusicTrack): string | null {
  if (track.url) return track.url;
  switch (track.source) {
    case "spotify":
      return `https://open.spotify.com/${track.kind ?? "track"}/${encodeURIComponent(track.id)}`;
    case "youtube":
      return track.kind === "playlist"
        ? `https://www.youtube.com/playlist?list=${encodeURIComponent(track.id)}`
        : `https://youtu.be/${encodeURIComponent(track.id)}`;
    case "soundcloud":
      return `https://soundcloud.com/${track.id}`;
    case "ipfs":
      return null;
  }
}

/** Suggested iframe height for an embed, by platform/kind. */
export function trackEmbedHeight(track: MusicTrack): number {
  if (track.source === "spotify") {
    return track.kind === "album" || track.kind === "playlist" || track.kind === "artist"
      ? 352
      : 152;
  }
  if (track.source === "soundcloud") return 166;
  // YouTube uses a 16:9 aspect-ratio wrapper instead of a fixed height.
  return 0;
}
