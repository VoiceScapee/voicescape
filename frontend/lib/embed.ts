/**
 * Embeddable tip widget — URL and snippet builders.
 *
 * Lets any creator paste a "tip me" button on an external site (Carrd,
 * Linktree, a blog). The iframe points at /embed/tip/[username], which runs
 * the standard on-chain tip flow (98% creator / 2% treasury) inside the
 * frame — no new payment logic, no new services.
 *
 * Pure functions only (no DOM, no wallet): trivially testable.
 */
import { siteUrl } from "@/lib/seo";
import { isValidUsername } from "@/lib/identity";

export const EMBED_TIP_PATH = "/embed/tip";
export const EMBED_WIDTH = 320;
export const EMBED_HEIGHT = 480;
/** Preset tip amounts offered on the "get your code" page (USD). */
export const EMBED_AMOUNT_PRESETS = [1, 5, 10, 25];

export interface EmbedTipOptions {
  /**
   * Preselect a tip amount in the widget (USD). Clamped to 1..1000;
   * omitted when out of range. Display default only.
   */
  amount?: number;
}

/**
 * Normalize a user-typed handle into a registry username.
 * Strips a leading @, trims, lowercases. Returns null when the result is
 * not a valid on-chain username (see lib/identity.ts).
 */
export function normalizeEmbedUsername(input: string): string | null {
  const v = input.trim().replace(/^@+/, "").toLowerCase();
  return v && isValidUsername(v) ? v : null;
}

/** Clamp a preset amount to the sane range, or null when unusable. */
export function normalizeEmbedAmount(amount: unknown): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  const n = Math.round(amount);
  return n >= 1 && n <= 1000 ? n : null;
}

/** Absolute URL of the embeddable tip widget for a username. */
export function buildEmbedTipUrl(username: string, opts: EmbedTipOptions = {}): string {
  const name = normalizeEmbedUsername(username);
  if (!name) throw new Error(`Invalid Voicescape username: ${username}`);
  const params = new URLSearchParams();
  const amount = normalizeEmbedAmount(opts.amount);
  if (amount != null) params.set("amount", String(amount));
  const q = params.toString();
  return `${siteUrl()}${EMBED_TIP_PATH}/${name}${q ? `?${q}` : ""}`;
}

/** Escape a string for safe interpolation into an HTML attribute. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Copy-paste iframe snippet for a creator's external site.
 *
 * The sandbox keeps the widget functional (scripts + same-origin storage
 * for the wallet session, popups for wallet pairing) while the embedding
 * page stays cross-origin: it cannot read the visitor's Voicescape
 * session, wallet state, or anything inside the frame.
 */
export function buildEmbedTipSnippet(username: string, opts: EmbedTipOptions = {}): string {
  const url = buildEmbedTipUrl(username, opts);
  const name = normalizeEmbedUsername(username) as string;
  return (
    `<iframe src="${escapeAttr(url)}" ` +
    `width="${EMBED_WIDTH}" height="${EMBED_HEIGHT}" ` +
    `style="border:0;border-radius:16px;max-width:100%;" ` +
    `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" ` +
    `title="Tip @${escapeAttr(name)} on Voicescape"></iframe>`
  );
}
