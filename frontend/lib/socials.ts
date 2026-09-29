/**
 * Social platform detection + URL normalization for the "socials" block.
 *
 * Pure and dependency-free: imported by lib/schema.ts, PageRenderer, and
 * the builder. Brand display names are intentionally never translated
 * (X is X in every language).
 */

export const PLATFORM_IDS = [
  "x",
  "instagram",
  "tiktok",
  "youtube",
  "twitch",
  "facebook",
  "discord",
  "linkedin",
  "github",
  "website",
] as const;

/** A recognized social platform, or "website" for anything else. */
export type PlatformId = (typeof PLATFORM_IDS)[number];

export interface PlatformInfo {
  id: PlatformId;
  /** Display name shown in the builder and as icon tooltips. */
  name: string;
}

export const PLATFORMS: Record<PlatformId, PlatformInfo> = {
  x: { id: "x", name: "X" },
  instagram: { id: "instagram", name: "Instagram" },
  tiktok: { id: "tiktok", name: "TikTok" },
  youtube: { id: "youtube", name: "YouTube" },
  twitch: { id: "twitch", name: "Twitch" },
  facebook: { id: "facebook", name: "Facebook" },
  discord: { id: "discord", name: "Discord" },
  linkedin: { id: "linkedin", name: "LinkedIn" },
  github: { id: "github", name: "GitHub" },
  website: { id: "website", name: "Website" },
};

export function isPlatformId(v: unknown): v is PlatformId {
  return typeof v === "string" && (PLATFORM_IDS as readonly string[]).includes(v);
}

/** Host suffixes identifying each platform. Subdomains match too. */
const PLATFORM_HOSTS: { id: Exclude<PlatformId, "website">; hosts: string[] }[] = [
  { id: "x", hosts: ["x.com", "twitter.com"] },
  { id: "instagram", hosts: ["instagram.com"] },
  { id: "tiktok", hosts: ["tiktok.com"] },
  { id: "youtube", hosts: ["youtube.com", "youtu.be"] },
  { id: "twitch", hosts: ["twitch.tv"] },
  { id: "facebook", hosts: ["facebook.com", "fb.com", "fb.watch"] },
  { id: "discord", hosts: ["discord.com", "discord.gg"] },
  { id: "linkedin", hosts: ["linkedin.com"] },
  { id: "github", hosts: ["github.com"] },
];

function stripCommonSubdomain(host: string): string {
  return host.replace(/^(www\.|m\.|mobile\.)/, "");
}

/**
 * Pull a lowercase bare host out of a full URL or a schemeless
 * `host/path`. Returns null for bare handles and junk.
 */
function extractHost(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  const schemeMatch = v.match(/^https?:\/\/([^/?#]+)/);
  if (schemeMatch) return stripCommonSubdomain(schemeMatch[1]);
  // Schemeless `host/path` — the dot requirement keeps bare handles
  // like "@user" from matching.
  const bareMatch = v.match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/?#]|$)/);
  if (bareMatch) return stripCommonSubdomain(bareMatch[1]);
  return null;
}

/**
 * Detect which platform a URL belongs to from its host.
 * Anything unrecognized (or unparseable) is "website" — never throws.
 */
export function detectPlatform(raw: string): PlatformId {
  const host = extractHost(raw);
  if (!host) return "website";
  for (const { id, hosts } of PLATFORM_HOSTS) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) return id;
  }
  return "website";
}

/**
 * Normalize pasted input into a full https URL, or null when it can't be
 * made into one. Accepts full URLs and schemeless `domain/path`; bare
 * handles like `@user` (no determinable platform) return null so the
 * caller can ask for a full profile link instead.
 *
 * Note: this is input shaping, not a security boundary — the renderer
 * still passes every URL through safeExternalUrl before linking.
 */
export function normalizeSocialUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v || /\s/.test(v)) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#].*)?$/i.test(v)) return `https://${v}`;
  return null;
}
