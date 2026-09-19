/**
 * Lobby test-message filter for the public landing preview.
 *
 * The town-hall lobby lives on an immutable HCS topic, so test messages
 * posted during development ("Echo flow test", "Please ignore", …) can
 * never be deleted. The landing page's "Happening in the lobby" preview
 * must not showcase them as community activity — it skips them instead.
 *
 * The town-hall room itself keeps its full, unedited history; this filter
 * applies only to the public landing showcase.
 */
const TEST_MESSAGE_PATTERNS: RegExp[] = [
  /please ignore/i,
  /\[audit/i,
  /^test$/i,
  /end-?to-?end test/i,
  /echo flow test/i,
  /verifying chat post/i,
];

/** True when a lobby message body is a known dev/test post, not community chat. */
export function isLobbyTestMessage(body: string): boolean {
  if (!body) return false;
  return TEST_MESSAGE_PATTERNS.some((re) => re.test(body));
}
