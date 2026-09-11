/**
 * Voicescape founders — pages that get the platform Founder badge.
 *
 * This is a simple config list (not derived from on-chain data) so it can
 * be changed without a contract deploy. To add a team member, append their
 * registered username below. Comparison is case-insensitive.
 */
export const FOUNDER_USERNAMES: readonly string[] = ["brandon", "0xcreator", "user-10424063"];

/** True when the page's username belongs to a Voicescape founder. */
export function isFounderUsername(username: string | null | undefined): boolean {
  if (!username) return false;
  const name = username.trim().toLowerCase();
  return FOUNDER_USERNAMES.includes(name);
}
