/**
 * Share URL builders for blockpages.
 *
 * Pure functions (no window access) so they are unit-testable.
 * Every shared page URL carries ?ref=<username> so the sharer earns
 * referral credit when someone joins Voicescape through the link —
 * the ?ref= param is captured into localStorage by RootProviders and
 * recorded on-chain when the new user publishes their page.
 */

/** Lowercase, trimmed username for the ref query param. */
export function normalizeRef(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Canonical shareable page URL with the referral code embedded.
 * e.g. buildPageShareUrl("https://voicescape.vercel.app", "user-10424063")
 *   → "https://voicescape.vercel.app/user-10424063?ref=user-10424063"
 */
export function buildPageShareUrl(origin: string, username: string): string {
  const clean = origin.replace(/\/+$/, "");
  const ref = encodeURIComponent(normalizeRef(username));
  return `${clean}/${encodeURIComponent(username)}?ref=${ref}`;
}

/** Default share text for a blockpage. */
export function buildShareText(username: string): string {
  return `Check out ${username}'s blockpage on Voicescape`;
}

/** X (Twitter) share intent URL. */
export function buildXShareUrl(pageUrl: string, text: string): string {
  const url = encodeURIComponent(pageUrl);
  const encoded = encodeURIComponent(text);
  return `https://x.com/intent/post?url=${url}&text=${encoded}`;
}

/** Facebook sharer URL. */
export function buildFacebookShareUrl(pageUrl: string): string {
  const url = encodeURIComponent(pageUrl);
  return `https://www.facebook.com/sharer/sharer.php?u=${url}`;
}
