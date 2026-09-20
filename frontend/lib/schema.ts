/**
 * Canonical Voicescape page schema.
 *
 * Define types ONCE here and import everywhere: templates, editor,
 * PageRenderer, and the BYOK vibecode system prompt (lib/byok.ts).
 */
export type Block =
  | {
    type: "hero";
    title: string;
    subtitle?: string;
    avatarEmoji?: string;
    avatarImage?: string;
    /**
     * Small text chips rendered beside the platform Founder badge
     * (e.g. HUMAN on the founder's page). The Founder badge itself
     * stays renderer-owned; these are page-authored identity chips.
     */
    badges?: string[];
  }
  | { type: "bio"; text: string }
  | { type: "links"; items: { label: string; url: string }[] }
  | { type: "tipJar"; message?: string }
  | { type: "guestbook"; entries: { name: string; message: string; date: string }[] }
  /** Real music: platform embeds (licensed by the platform) + the owner's own IPFS uploads. */
  | { type: "music"; title?: string; tracks: MusicTrack[]; note?: string }
  | { type: "gallery"; images: string[]; effect?: "dance" | "marquee" | "float" } // ":logo:" renders the first-party Voicescape logo; emoji still work; https: URLs (e.g. Buddy-generated IPFS artwork) render as images via safeImageUrl.
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
  | { type: "booking"; title?: string; items: { label: string; url: string; note?: string }[] }
  /**
   * Livestream embed (Twitch/YouTube player + Twitch chat). The blockpage is
   * never in the video pipeline — the owner streams to the platform directly
   * (OBS/phone app) and the block only embeds the platform's player.
   * `channel` is the Twitch login name or the YouTube UC… channel ID.
   */
  | { type: "livestream"; platform: "twitch" | "youtube"; channel: string; title?: string }
  /**
   * Blockchain Heartbeat (builder module #14): the page's live chain
   * connection. Hairline EKG trace + status dot + micro-mono readout;
   * each real settled tip on the page wallet draws one violet/mint spike.
   * On by default for blockchain pages; the renderer needs the page
   * owner's wallet (passed as tipOwner) to poll /api/heartbeat.
   */
  | { type: "heartbeat"; showProofChips?: boolean }
  /**
   * Badges: a centered row of small uppercase chips (e.g. profile badges
   * like HUMAN · FOUNDER · MAINNET, or hero chips like MAINNET → ONE LIFE).
   * Plain text chips — the platform Founder badge stays renderer-owned.
   */
  | { type: "badges"; items: string[] }
  /**
   * Tabbed presentation: a small set of labeled tabs, each holding its own
   * blocks (e.g. Proof vs Profile badges). Renderers recurse through
   * BlockView with the same page props. Max 4 tabs, 8 blocks per tab.
   */
  | { type: "tabs"; tabs: { label: string; blocks: Block[] }[] }
  /**
   * Native page chat room. Anyone with a wallet session can chat; the page
   * owner moderates (mute/ban/delete, promote/demote mods). Off-chain relay,
   * rate-limited — the page's own chat, no platform account needed.
   */
  | { type: "chat"; title?: string };

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
 * Featured profile song: a reference to one track on the page.
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

/**
 * Strict livestream channel sanitizer. Returns the safe channel string or
 * null when the input can't be embedded safely.
 * - Twitch: channel login names are 1–25 chars of [A-Za-z0-9_].
 * - YouTube: must be a UC… channel ID (@handles do not work in the
 *   live_stream embed). Pure and dependency-free.
 */
export function sanitizeLivestreamChannel(
  platform: "twitch" | "youtube",
  channel: string,
): string | null {
  const c = channel.trim();
  if (platform === "twitch") {
    return /^[A-Za-z0-9_]{1,25}$/.test(c) ? c : null;
  }
  return /^UC[A-Za-z0-9_-]{10,}$/.test(c) ? c : null;
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
  /** Featured profile song. Renderers must ignore refs that don't resolve. */
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
  "livestream",
  "chat",
  "heartbeat",
  "tabs",
  "badges",
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
    case "livestream":
      return { type: "livestream", platform: "twitch", channel: "" };
    case "chat":
      return { type: "chat", title: "Chat" };
    case "heartbeat":
      return { type: "heartbeat" };
    case "tabs":
      return { type: "tabs", tabs: [{ label: "Tab", blocks: [] }] };
    case "badges":
      return { type: "badges", items: ["Badge"] };
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
    // Livestream blocks: platform must be a known embed provider, channel a
    // short string (the component sanitizes it strictly before embedding).
    if (type === "livestream") {
      const lb = b as Record<string, unknown>;
      if (lb.platform !== "twitch" && lb.platform !== "youtube") return false;
      if (typeof lb.channel !== "string" || lb.channel.length > 64) return false;
      if (lb.title !== undefined && typeof lb.title !== "string") return false;
    }
    // Chat blocks: optional title only.
    if (type === "chat") {
      const cb = b as Record<string, unknown>;
      if (cb.title !== undefined && typeof cb.title !== "string") return false;
    }
    return true;
  });
}

/**
 * Render-safety normalizer for page blocks. Model-generated or user-supplied
 * page JSON can pass isValidPage (which only checks block `type`) while
 * missing the array fields PageRenderer maps over (e.g. a music block
 * without `tracks`) — or carrying WRONG-TYPED scalars where the renderer
 * expects strings (e.g. a hero `title` that is an object: `(block.title ||
 * "?").trim()` throws, and `{block.title}` as a React child throws
 * "Objects are not valid as a React child"). Either one unmounted the whole
 * app live (2026-09-16).
 *
 * This rebuilds every block from scratch: arrays are filled with [] and
 * their elements filtered/rebuilt, every renderer-touched scalar is
 * coerced to a string (or dropped when optional), and unknown block types
 * return null so the caller can skip them. A normalized page can never
 * crash the renderer. Pure and dependency-free.
 */
export function normalizeBlockForRender(input: unknown): Block | null {
  if (typeof input !== "object" || input === null) return null;
  const b = input as Record<string, unknown>;
  if (typeof b.type !== "string") return null;
  // String-or-undefined: the only safe shape for renderer-touched scalars.
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  const isObj = (e: unknown): e is Record<string, unknown> =>
    typeof e === "object" && e !== null;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  switch (b.type) {
    case "hero": {
      const hero: Record<string, unknown> = {
        type: "hero",
        title: str(b.title) ?? "?",
      };
      const subtitle = str(b.subtitle);
      if (subtitle !== undefined) hero.subtitle = subtitle;
      const avatarEmoji = str(b.avatarEmoji);
      if (avatarEmoji !== undefined) hero.avatarEmoji = avatarEmoji;
      const avatarImage = str(b.avatarImage);
      if (avatarImage !== undefined) hero.avatarImage = avatarImage;
      const badges = (Array.isArray(b.badges) ? b.badges : [])
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim().slice(0, 24))
        .filter((x) => x.length > 0)
        .slice(0, 4);
      if (badges.length > 0) hero.badges = badges;
      return hero as unknown as Block;
    }
    case "bio":
      return { type: "bio", text: str(b.text) ?? "" } as Block;
    case "tipJar": {
      const tip: Record<string, unknown> = { type: "tipJar" };
      const message = str(b.message);
      if (message !== undefined) tip.message = message;
      return tip as unknown as Block;
    }
    case "operator": {
      const op: Record<string, unknown> = {
        type: "operator",
        wallet: str(b.wallet) ?? "",
      };
      const name = str(b.name);
      if (name !== undefined) op.name = name;
      const url = str(b.url);
      if (url !== undefined) op.url = url;
      return op as unknown as Block;
    }
    case "livestream": {
      const platform = b.platform === "twitch" || b.platform === "youtube" ? b.platform : "youtube";
      const ls: Record<string, unknown> = {
        type: "livestream",
        platform,
        channel: str(b.channel) ?? "",
      };
      const title = str(b.title);
      if (title !== undefined) ls.title = title;
      return ls as unknown as Block;
    }
    case "chat": {
      const ch: Record<string, unknown> = { type: "chat" };
      const title = str(b.title);
      if (title !== undefined) ch.title = title;
      return ch as unknown as Block;
    }
    case "heartbeat": {
      const hb: Record<string, unknown> = { type: "heartbeat" };
      if (typeof b.showProofChips === "boolean") hb.showProofChips = b.showProofChips;
      return hb as unknown as Block;
    }
    case "badges": {
      const items = (Array.isArray(b.items) ? b.items : [])
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim().slice(0, 24))
        .filter((x) => x.length > 0)
        .slice(0, 8);
      if (items.length === 0) return null;
      return { type: "badges", items } as unknown as Block;
    }
    case "tabs": {
      // Tabbed presentation: nested blocks render through BlockView with
      // the same props (owner, tip name, preview). Sanitized recursively;
      // empty tabs are dropped so a tab never renders blank.
      const tabsIn = Array.isArray(b.tabs) ? b.tabs : [];
      const tabs = tabsIn.slice(0, 4).flatMap((t) => {
        if (typeof t !== "object" || t === null) return [];
        const tr = t as Record<string, unknown>;
        const label = (typeof tr.label === "string" ? tr.label : "Tab").slice(0, 24);
        const nested = (Array.isArray(tr.blocks) ? tr.blocks : [])
          .slice(0, 8)
          .map((n) => normalizeBlockForRender(n))
          .filter((n): n is Block => n !== null);
        if (nested.length === 0) return [];
        return [{ label, blocks: nested }];
      });
      if (tabs.length === 0) return null;
      return { type: "tabs", tabs } as unknown as Block;
    }
    case "links":
      return {
        type: "links",
        items: Array.isArray(b.items)
          ? b.items.filter(isObj).map((e) => ({
              label: str(e.label) ?? "Link",
              url: str(e.url) ?? "",
            }))
          : [],
      } as unknown as Block;
    case "guestbook":
    case "reviews": {
      const entries = Array.isArray(b.entries)
        ? b.entries.filter(isObj).map((e) => {
            const entry: Record<string, unknown> = {
              name: str(e.name) ?? "Anonymous",
              message: str(e.message) ?? "",
              date: str(e.date) ?? "",
            };
            const txHash = str(e.txHash);
            if (txHash !== undefined) entry.txHash = txHash;
            return entry;
          })
        : [];
      return (b.type === "guestbook"
        ? { type: "guestbook", entries }
        : {
            type: "reviews",
            entries,
            ...(str(b.title) !== undefined ? { title: str(b.title) } : {}),
          }) as unknown as Block;
    }
    case "music": {
      const tracks = Array.isArray(b.tracks)
        ? b.tracks.filter(isObj).flatMap((t) => {
            const source = str(t.source);
            const id = str(t.id);
            if (!source || !id) return [];
            const track: Record<string, unknown> = { source, id };
            for (const k of ["kind", "url", "title", "artist"] as const) {
              const v = str(t[k]);
              if (v !== undefined) track[k] = v;
            }
            return [track];
          })
        : [];
      const music: Record<string, unknown> = { type: "music", tracks };
      const title = str(b.title);
      if (title !== undefined) music.title = title;
      const note = str(b.note);
      if (note !== undefined) music.note = note;
      return music as unknown as Block;
    }
    case "gallery": {
      const gallery: Record<string, unknown> = {
        type: "gallery",
        images: Array.isArray(b.images)
          ? b.images.filter((e): e is string => typeof e === "string")
          : [],
      };
      const effect = str(b.effect);
      if (effect === "dance" || effect === "marquee" || effect === "float")
        gallery.effect = effect;
      return gallery as unknown as Block;
    }
    case "top8": {
      const top8: Record<string, unknown> = {
        type: "top8",
        friends: Array.isArray(b.friends)
          ? b.friends.filter(isObj).map((f) => {
              const friend: Record<string, unknown> = {
                name: str(f.name) ?? "?",
              };
              const avatarEmoji = str(f.avatarEmoji);
              if (avatarEmoji !== undefined) friend.avatarEmoji = avatarEmoji;
              const url = str(f.url);
              if (url !== undefined) friend.url = url;
              return friend;
            })
          : [],
      };
      const title = str(b.title);
      if (title !== undefined) top8.title = title;
      return top8 as unknown as Block;
    }
    case "services":
      return {
        type: "services",
        items: Array.isArray(b.items)
          ? b.items.filter(isObj).map((e) => ({
              name: str(e.name) ?? "Service",
              description: str(e.description) ?? "",
              priceUsdCents: num(e.priceUsdCents, 0),
              endpoint: str(e.endpoint) ?? "",
            }))
          : [],
      } as unknown as Block;
    case "capabilities":
      return {
        type: "capabilities",
        items: Array.isArray(b.items)
          ? b.items.filter((e): e is string => typeof e === "string")
          : [],
      } as unknown as Block;
    case "booking": {
      const booking: Record<string, unknown> = {
        type: "booking",
        items: Array.isArray(b.items)
          ? b.items.filter(isObj).map((e) => {
              const item: Record<string, unknown> = {
                label: str(e.label) ?? "Book",
                url: str(e.url) ?? "",
              };
              const note = str(e.note);
              if (note !== undefined) item.note = note;
              return item;
            })
          : [],
      };
      const title = str(b.title);
      if (title !== undefined) booking.title = title;
      return booking as unknown as Block;
    }
    default:
      return null;
  }
}

/**
 * Deterministic server-built preview mock (template fallback). When the
 * model fails to produce a valid mock (truncated/invalid JSON even after a
 * retry), the preview turn still delivers a REAL visual mock built from
 * the collected username/bio/vibe — placeholder art only, never AI image
 * generation. Always passes isValidPage and always renders. The visitor
 * never sees raw JSON, never sees a crash, never sees nothing.
 *
 * ROUND 4 (2026-09-16): the template is now the PRIMARY mock path, not
 * just the fallback — the model writes conversational text only and the
 * mock is built here deterministically every time, so a garbled model
 * reply can never break the visual preview.
 */
const PREVIEW_DARK_THEME = {
  background: "#1e1e1e",
  foreground: "#f5f5f5",
  accent: "#ffcc00",
  fontFamily: "system-ui, sans-serif",
};
const PREVIEW_LIGHT_THEME = {
  background: "#fafafa",
  foreground: "#1a1a1a",
  accent: "#7c3aed",
  fontFamily: "system-ui, sans-serif",
};

/** Accent palette cycled for visible mock-to-mock variation. */
const PREVIEW_ACCENTS = [
  "#ffcc00",
  "#a855f7",
  "#3b82f6",
  "#22c55e",
  "#ec4899",
  "#22d3ee",
  "#f97316",
] as const;

const PREVIEW_COLOR_WORDS: Array<{ re: RegExp; name: string; hex: string }> = [
  { re: /\b(purple|violet|lavender)\b/, name: "purple", hex: "#a855f7" },
  { re: /\b(blue|navy|azure)\b/, name: "blue", hex: "#3b82f6" },
  { re: /\b(green|emerald|mint)\b/, name: "green", hex: "#22c55e" },
  { re: /\b(pink|magenta|rose)\b/, name: "pink", hex: "#ec4899" },
  { re: /\b(red|crimson|scarlet)\b/, name: "red", hex: "#ef4444" },
  { re: /\b(gold|yellow|amber)\b/, name: "gold", hex: "#ffcc00" },
  { re: /\b(cyan|teal|turquoise|aqua)\b/, name: "cyan", hex: "#22d3ee" },
  { re: /\b(orange|tangerine|peach)\b/, name: "orange", hex: "#f97316" },
];

const PREVIEW_EMOJI_WORDS: Array<{ re: RegExp; emoji: string; name: string }> = [
  { re: /\brocket\b/, emoji: "🚀", name: "rocket" },
  { re: /\b(music|guitar|band|rock)\b/, emoji: "🎸", name: "guitar" },
  { re: /\b(art|paint|draw)\b/, emoji: "🎨", name: "art" },
  { re: /\b(game|gaming|gamer)\b/, emoji: "🎮", name: "gaming" },
  { re: /\b(moon|night)\b/, emoji: "🌙", name: "moon" },
  { re: /\bfire\b/, emoji: "🔥", name: "fire" },
  { re: /\b(crown|king|queen|royal)\b/, emoji: "👑", name: "crown" },
  { re: /\b(alien|space)\b/, emoji: "👽", name: "alien" },
  { re: /\bheart\b/, emoji: "💜", name: "heart" },
  { re: /\bstar\b/, emoji: "✨", name: "star" },
];

export function templatePreviewPage(
  username: string,
  bio: string,
  vibe: string
): VoicescapePage {
  const u = (username || "you").toLowerCase().trim() || "you";
  const display = u.charAt(0).toUpperCase() + u.slice(1);
  const vibeLower = (vibe || "").toLowerCase();
  const dark = /dark|midnight|noir|grunge|metal|night|emo|goth/.test(vibeLower);
  const light = /light|clean|minimal|bright|pastel|soft/.test(vibeLower) && !dark;
  const theme = dark || !light ? { ...PREVIEW_DARK_THEME } : { ...PREVIEW_LIGHT_THEME };
  const avatarEmoji = /music|dj|band|rock/.test(vibeLower)
    ? "🎸"
    : /art|design|paint/.test(vibeLower)
      ? "🎨"
      : /game|gaming/.test(vibeLower)
        ? "🎮"
        : /dark|night/.test(vibeLower)
          ? "🌙"
          : "✨";
  const bioText = (bio || "").trim() || `Welcome to ${display}'s corner of the internet.`;
  return {
    version: 1,
    username: u,
    theme,
    blocks: [
      { type: "hero", title: display, subtitle: `${display} — ${vibeLower || "my vibe"}`, avatarEmoji },
      { type: "bio", text: bioText },
      {
        type: "links",
        items: [
          { label: "𝕏 / Twitter", url: `https://x.com/${u}` },
          { label: "Website", url: `https://voicescape.vercel.app/${u}` },
          { label: "Say hi", url: `https://t.me/${u}` },
        ],
      },
      { type: "tipJar", message: "Thanks for stopping by — tips keep the lights on! 💜" },
    ],
  };
}

export interface PreviewTweakResult {
  page: VoicescapePage;
  /** Short human sentence describing the visible change (appended to the reply). */
  note: string;
}

/**
 * Deterministic mock revision (mock #2 of the free preview flow). Applies
 * the visitor's plain-text tweak to the served mock: theme (dark/light),
 * accent color words, avatar emoji words, and a "bigger/bolder hero"
 * intent. Unknown tweaks still produce a VISIBLE variation (accent cycle)
 * plus a note asking for specifics — mock #2 is never identical to mock
 * #1 and never fails to render. Pure and dependency-free.
 */
export function applyPreviewTweak(
  base: VoicescapePage,
  tweak: string
): PreviewTweakResult {
  const safeBase = isValidPage(base)
    ? (JSON.parse(JSON.stringify(base)) as VoicescapePage)
    : templatePreviewPage("you", "", "");
  const page = safeBase;
  const t = (tweak || "").toLowerCase();
  const changes: string[] = [];

  if (/\bdarker\b|\bdark mode\b|\bgo dark\b/.test(t)) {
    page.theme = { ...page.theme, ...PREVIEW_DARK_THEME };
    changes.push("a darker theme");
  } else if (/\blighter\b|\blight mode\b|\bgo light\b|\bbrighter\b|\bbright\b/.test(t)) {
    page.theme = { ...page.theme, ...PREVIEW_LIGHT_THEME };
    changes.push("a lighter theme");
  }
  for (const c of PREVIEW_COLOR_WORDS) {
    if (c.re.test(t)) {
      page.theme = { ...page.theme, accent: c.hex };
      changes.push(`${c.name} accents`);
      break;
    }
  }
  const hero = page.blocks.find((b) => b.type === "hero");
  for (const e of PREVIEW_EMOJI_WORDS) {
    if (e.re.test(t) && hero && hero.type === "hero") {
      (hero as { avatarEmoji?: string }).avatarEmoji = e.emoji;
      changes.push(`a ${e.name} avatar`);
      break;
    }
  }
  if (
    /\bhero\b/.test(t) &&
    /\b(bigger|big|bold|bolder|large|larger|huge|punchier|prominent)\b/.test(t)
  ) {
    page.theme = { ...page.theme, ...PREVIEW_DARK_THEME };
    if (hero && hero.type === "hero") {
      (hero as { avatarEmoji?: string }).avatarEmoji = "🚀";
    }
    changes.push("a bolder hero");
  }

  if (changes.length === 0) {
    // Unknown tweak: still visibly different — cycle the accent palette
    // deterministically off the tweak text, and say what happened.
    let hash = 0;
    for (const ch of t) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const currentIdx = PREVIEW_ACCENTS.indexOf(
      page.theme.accent as (typeof PREVIEW_ACCENTS)[number]
    );
    const next =
      PREVIEW_ACCENTS[(hash + Math.max(0, currentIdx) + 1) % PREVIEW_ACCENTS.length];
    page.theme = { ...page.theme, accent: next };
    return {
      page,
      note:
        "I gave your mock a fresh accent color — tell me exactly what to change (like “darker”, “purple”, or “rocket avatar”) and I'll apply it.",
    };
  }
  return { page, note: `Updated your mock: ${changes.join(", ")}.` };
}
