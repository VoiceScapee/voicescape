/**
 * Sanitize a user-supplied URL before rendering it as an <a href>.
 *
 * Only absolute http: and https: URLs are allowed. Everything else —
 * javascript:, data:, vbscript:, file:, relative paths, bare strings —
 * returns null so the caller can render plain text instead.
 *
 * This is the single choke point for all user-controlled links on public
 * pages (links block, booking block, top8, operator disclosure, music
 * "open in app"). Never render a page-JSON URL as href without it.
 */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  // Anchor the scheme check at the start; the `i` flag catches
  // JaVaScRiPt: casing. Leading whitespace is trimmed above so
  // "  javascript:..." can't sneak past.
  if (/^https?:\/\//i.test(v)) return v;
  return null;
}
