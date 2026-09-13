/**
 * Voicescape founders — pages that get the platform Founder badge.
 *
 * This is a simple config list (not derived from on-chain data) so it can
 * be changed without a contract deploy. To add a team member, append their
 * registered username below. Comparison is case-insensitive.
 *
 * SECURITY: the badge must be gated on the CANONICAL route username (the
 * name that resolved on-chain via /api/resolve), never on `page.username`
 * from the IPFS page JSON — IPFS content is user-controlled and anyone
 * could otherwise pin a JSON with a founder username to spoof the badge.
 * PageRenderer takes a `canonicalUsername` prop for exactly this reason.
 */
export const FOUNDER_USERNAMES: readonly string[] = ["user-10424063"];

/** True when the page's username belongs to a Voicescape founder. */
export function isFounderUsername(username: string | null | undefined): boolean {
  if (!username) return false;
  const name = username.trim().toLowerCase();
  return FOUNDER_USERNAMES.includes(name);
}

/**
 * Pure badge-gating rule, extracted for testing.
 *
 * The badge MUST be decided from the canonical route username (verified
 * on-chain via /api/resolve). The IPFS page JSON's username is
 * user-controlled — anyone can pin `{"username": "user-10424063"}` — so it
 * may only be used as a preview fallback, never as the authority on a
 * public route.
 */
export function resolveFounderBadge(
  canonicalUsername: string | null | undefined,
  pageUsername: string | null | undefined,
): boolean {
  return isFounderUsername(canonicalUsername ?? pageUsername);
}
