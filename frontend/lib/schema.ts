/**
 * Canonical Voicescape page schema.
 *
 * Define types ONCE here and import everywhere: templates, editor,
 * PageRenderer, and the BYOK vibecode system prompt (lib/byok.ts).
 */
export type Block =
  | { type: "hero"; title: string; subtitle?: string; avatarEmoji?: string }
  | { type: "bio"; text: string }
  | { type: "links"; items: { label: string; url: string }[] }
  | { type: "tipJar"; message?: string }
  | { type: "guestbook"; entries: { name: string; message: string; date: string }[] }
  /** Real music: platform embeds (licensed by the platform) + the owner's own IPFS uploads. */
  | { type: "music"; title?: string; tracks: MusicTrack[]; note?: string }
  | { type: "gallery"; images: string[] } // MVP: emoji/CSS placeholders, no external images
  | { type: "top8"; title?: string; friends: { name: string; avatarEmoji?: string; url?: string }[] }
  // ---- Phase B (agent + commerce) blocks ----
  /** Paid API services an agent sells per call. "Pay per call" runs the x402 payment flow. */
  | { type: "services"; items: { name: string; description: string; priceUsdCents: number; endpoint: string }[] }
  /** Machine-readable capability tags (searchable in the agent directory). */
  | { type: "capabilities"; items: string[] }
  /** Operator disclosure for agent pages. Rendered from the on-chain operator field. */
  | { type: "operator"; wallet: string; name?: string; url?: string }
  /** Reviews with optional txHash linking the review to a real payment (viewable on HashScan). */
  | { type: "reviews"; title?: string; entries: { name: string; message: string; date: string; txHash?: string }[] }
  /** Booking links for human business pages. */
  | { type: "booking"; title?: string; items: { label: string; url: string; note?: string }[] };

/** On-chain owner type. 0 = HUMAN, 1 = AGENT (matches VoicescapeRegistry). */
export type OwnerType = "human" | "agent";

/**
 * Where a music track comes from. Platform embeds are the copyright-safe path
 * (the platform holds the licenses); "ipfs" is the page owner's own upload.
 */
export type MusicSource = "spotify" | "youtube" | "soundcloud" | "ipfs";

export interface MusicTrack {
  source: MusicSource;
  /** Embed ID (spotify/youtube/soundcloud) or IPFS CID ("ipfs"). */
  id: string;
  /** What the track is on its platform, e.g. spotify "track"|"album"|"playlist"|"episode", youtube "video"|"playlist". */
  kind?: string;
  /** The original pasted URL, kept for reference / "open in app" links. */
  url?: string;
  title?: string;
  artist?: string;
}

/**
 * MySpace-style profile song: a reference to one track on the page.
 * Indices are best-effort — renderers must ignore refs that don't resolve.
 */
export interface ProfileSongRef {
  /** Index into the page's blocks array of the music block. */
  blockIndex: number;
  /** Index into that block's tracks array. */
  trackIndex: number;
}

/** Structural check for a single music track. Pure and dependency-free. */
export function isValidMusicTrack(input: unknown): input is MusicTrack {
  if (typeof input !== "object" || input === null) return false;
  const t = input as Record<string, unknown>;
  if (t.source !== "spotify" && t.source !== "youtube" && t.source !== "soundcloud" && t.source !== "ipfs")
    return false;
  if (typeof t.id !== "string" || t.id.length === 0 || t.id.length > 512) return false;
  for (const k of ["kind", "url", "title", "artist"] as const) {
    if (t[k] !== undefined && typeof t[k] !== "string") return false;
  }
  return true;
}

/** Structural check for a profile-song reference. Pure and dependency-free. */
export function isValidProfileSongRef(input: unknown): input is ProfileSongRef {
  if (typeof input !== "object" || input === null) return false;
  const r = input as Record<string, unknown>;
  return (
    Number.isInteger(r.blockIndex) &&
    (r.blockIndex as number) >= 0 &&
    Number.isInteger(r.trackIndex) &&
    (r.trackIndex as number) >= 0
  );
}

/** Registry metadata mirrored from the on-chain Page record (source of truth on-chain). */
export interface RegistryMeta {
  owner: string;
  ownerType: OwnerType;
  operator: string;
  purpose: string;
}

export interface VoicescapePage {
  version: 1;
  username: string;
  /** Informational only — the on-chain registry record is the source of truth. */
  ownerType?: OwnerType;
  /** For agent pages: what the agent is for. Also stored on-chain. */
  purpose?: string;
  /** MySpace-style featured song. Renderers must ignore refs that don't resolve. */
  profileSong?: ProfileSongRef;
  theme: {
    background: string;
    foreground: string;
    accent: string;
    fontFamily: string;
  };
  blocks: Block[];
}

export const BLOCK_TYPES = [
  "hero",
  "bio",
  "links",
  "tipJar",
  "guestbook",
  "music",
  "gallery",
  "top8",
  "services",
  "capabilities",
  "operator",
  "reviews",
  "booking",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

/** Create a blank block of the given type with sensible defaults. */
export function createDefaultBlock(type: BlockType, username = ""): Block {
  switch (type) {
    case "hero":
      return { type: "hero", title: username || "Your Name", avatarEmoji: "👋" };
    case "bio":
      return { type: "bio", text: "A short bio about you." };
    case "links":
      return { type: "links", items: [{ label: "My link", url: "https://example.com" }] };
    case "tipJar":
      return { type: "tipJar", message: "Support my work with a tip!" };
    case "guestbook":
      return { type: "guestbook", entries: [] };
    case "music":
      return { type: "music", title: "My music", tracks: [] };
    case "gallery":
      return { type: "gallery", images: ["🎨", "📸", "✨"] };
    case "top8":
      return { type: "top8", title: "Top 8", friends: [] };
    case "services":
      return {
        type: "services",
        items: [
          {
            name: "Example API",
            description: "Describe what this endpoint does.",
            priceUsdCents: 100,
            endpoint: "https://example.com/api",
          },
        ],
      };
    case "capabilities":
      return { type: "capabilities", items: ["example-capability"] };
    case "operator":
      return { type: "operator", wallet: "0x0000000000000000000000000000000000000000" };
    case "reviews":
      return { type: "reviews", entries: [] };
    case "booking":
      return {
        type: "booking",
        title: "Book me",
        items: [{ label: "Book a call", url: "https://example.com/book" }],
      };
  }
}

/** Lightweight runtime validation so the editor and vibecode route can reject junk. */
export function isValidPage(input: unknown): input is VoicescapePage {
  if (typeof input !== "object" || input === null) return false;
  const p = input as Record<string, unknown>;
  if (p.version !== 1) return false;
  if (typeof p.username !== "string") return false;
  if (typeof p.theme !== "object" || p.theme === null) return false;
  const t = p.theme as Record<string, unknown>;
  for (const k of ["background", "foreground", "accent", "fontFamily"]) {
    if (typeof t[k] !== "string") return false;
  }
  if (!Array.isArray(p.blocks)) return false;
  // Optional page-level profile song must be structurally valid when present.
  if (p.profileSong !== undefined && !isValidProfileSongRef(p.profileSong)) return false;
  return p.blocks.every((b) => {
    if (typeof b !== "object" || b === null) return false;
    const type = (b as Record<string, unknown>).type;
    if (!(BLOCK_TYPES as readonly string[]).includes(type as string)) return false;
    // Music blocks: legacy {title, note} shapes without tracks stay valid;
    // when tracks are present each one must be structurally sound.
    if (type === "music") {
      const tracks = (b as Record<string, unknown>).tracks;
      if (tracks !== undefined && (!Array.isArray(tracks) || !tracks.every(isValidMusicTrack)))
        return false;
    }
    return true;
  });
}
