import { imageGatewayUrl } from "./ipfs";

/**
 * Sanitize a user-supplied avatar image URL before rendering it in an <img>.
 *
 * Stricter than safeExternalUrl: only absolute https: URLs — and ipfs://
 * CIDs, which are resolved to the configured gateway — are allowed. http:,
 * javascript:, data:, vbscript:, and everything else return null. Images are
 * passive fetch targets, so an http: URL would leak the page visit over
 * cleartext and break under mixed-content blocking.
 *
 * This is the single choke point for page-JSON avatar photos (hero,
 * top8). Never render an <img src> from page JSON without it.
 */
export function safeImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  // Anchor the scheme check at the start; the `i` flag catches
  // HTTPS: casing. Leading whitespace is trimmed above.
  if (/^https:\/\//i.test(v)) return v;
  if (/^ipfs:\/\//i.test(v)) {
    const cid = v.slice("ipfs://".length).trim();
    // Bare CIDs only: base58 Qm… (46 chars) or base32 bafy/bafk… (50+).
    // No paths, no nested schemes, nothing else after the CID.
    if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/.test(cid)) {
      return imageGatewayUrl(cid);
    }
  }
  return null;
}

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

/**
 * Open an external URL from a tap/click.
 *
 * Wallet dapp browsers (in-app WebViews like HashPack's) silently swallow
 * target="_blank" anchors, so a plain link can look dead. Try a new tab
 * first; when the popup is blocked (window.open returns null or throws),
 * fall back to same-tab navigation so the tap always lands somewhere.
 *
 * The URL is re-validated through safeExternalUrl — javascript: never opens.
 */
export function openExternalUrl(raw: unknown): void {
  const url = safeExternalUrl(raw);
  if (!url || typeof window === "undefined") return;
  try {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (!win || win.closed) window.location.assign(url);
  } catch {
    window.location.assign(url);
  }
}
