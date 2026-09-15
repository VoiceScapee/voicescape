/**
 * Durable one-time congratulations for a Danny-built page going live.
 *
 * Two lanes, either one shows the message exactly once:
 *
 * 1. Server lane — POST /api/liaison/publish-confirm sets
 *    `liaison:celebrate:<wallet>`; GET /api/liaison/status returns it as
 *    `celebratedUsername` and clears it. Durable once the KV store is
 *    durable (Upstash); works across devices.
 *
 * 2. Browser lane (this module) — the builder stashes a celebration in
 *    localStorage when publish-confirm succeeds; the Danny panel picks it
 *    up as a fallback when the server flag is missing (e.g. the server KV
 *    was still the ephemeral in-memory fallback and got wiped by a deploy
 *    before the user came back). Same-browser, works today with zero
 *    infrastructure.
 *
 * When the server lane fires, the panel drops the browser backup so the
 * message can never double-fire. Both lanes share the 7-day TTL.
 */

export const LIAISON_CELEBRATE_LS_KEY = "vs_liaison_celebrate";
export const LIAISON_CELEBRATE_TTL_MS = 7 * 24 * 3600_000;

function storage(): Storage | null {
  try {
    const g = globalThis as { localStorage?: Storage };
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

export function congratsText(username: string): string {
  return (
    `🎉 Your page @${username} is live! I loved building that with you. ` +
    `It's all yours now — share it, tip it, make it yours.`
  );
}

/**
 * Stash a browser-lane celebration. Best-effort: never throws, never
 * blocks the publish flow. Bound to the publishing wallet so a later
 * wallet switch in the same browser can't show someone else's
 * congratulations.
 */
export function stashBrowserCelebration(username: string, wallet: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(
      LIAISON_CELEBRATE_LS_KEY,
      JSON.stringify({
        username: username.toLowerCase(),
        wallet: wallet.toLowerCase(),
        atMs: Date.now(),
      }),
    );
  } catch {
    /* private mode / quota — the server lane still applies */
  }
}

/**
 * Read-and-clear a pending browser-lane celebration. Returns the username
 * to celebrate, or null. Only fires for the wallet that published; a stale
 * (> TTL) or malformed entry is consumed silently and never shown.
 */
export function takeBrowserCelebration(nowMs: number, wallet?: string): string | null {
  const s = storage();
  if (!s) return null;
  let raw: string | null = null;
  try {
    raw = s.getItem(LIAISON_CELEBRATE_LS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  // Consume first: a stale or malformed entry must never linger and
  // surprise the user later.
  try {
    s.removeItem(LIAISON_CELEBRATE_LS_KEY);
  } catch {
    /* noop */
  }
  try {
    const c = JSON.parse(raw) as {
      username?: unknown;
      wallet?: unknown;
      atMs?: unknown;
    };
    if (typeof c.username !== "string" || !c.username) return null;
    if (typeof c.atMs === "number" && nowMs - c.atMs > LIAISON_CELEBRATE_TTL_MS)
      return null;
    // Wallet-bound: never congratulate the wrong wallet after a switch.
    // (Entries written before wallet-binding existed have no wallet and
    // are shown — there are none in the wild yet.)
    if (
      wallet &&
      typeof c.wallet === "string" &&
      c.wallet &&
      c.wallet.toLowerCase() !== wallet.toLowerCase()
    )
      return null;
    return c.username;
  } catch {
    return null;
  }
}

/** Drop the browser-lane backup (used when the server lane fires). */
export function clearBrowserCelebration(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(LIAISON_CELEBRATE_LS_KEY);
  } catch {
    /* noop */
  }
}
