/**
 * One-time "Your blockpage is live!" congrats card on Buddy's page (/forge).
 *
 * The builder stashes a flag when a claim lands on-chain
 * (stashClaimCongrats, called right after publish confirms). The public
 * blockpage renderer checks the flag ONLY on /forge: if a flag is pending
 * (unseen), the congrats card renders once and the flag is marked seen in
 * the same post-render effect — so it can never show twice.
 *
 * Browser-local (same-browser) by design — no server, no account lookup,
 * no PII beyond the username the user just claimed. Best-effort throughout:
 * storage failures must never block publish or page render.
 */

export const CLAIM_CONGRATS_LS_KEY = "vs_claim_congrats";
/** Flags older than this are dropped silently, never shown. */
export const CLAIM_CONGRATS_TTL_MS = 30 * 24 * 3600_000;

export interface ClaimCongratsRecord {
  username: string;
  wallet: string;
  atMs: number;
  seen: boolean;
}

function storage(): Storage | null {
  try {
    const g = globalThis as { localStorage?: Storage };
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

function parseRecord(raw: string): ClaimCongratsRecord | null {
  try {
    const c = JSON.parse(raw) as {
      username?: unknown;
      wallet?: unknown;
      atMs?: unknown;
      seen?: unknown;
    };
    if (typeof c.username !== "string" || !c.username) return null;
    return {
      username: c.username.toLowerCase(),
      wallet: typeof c.wallet === "string" ? c.wallet.toLowerCase() : "",
      atMs: typeof c.atMs === "number" ? c.atMs : 0,
      seen: c.seen === true,
    };
  } catch {
    return null;
  }
}

/**
 * Stash a pending congrats flag. Best-effort: never throws, never blocks
 * the publish flow. Overwrites any earlier pending flag (one claim at a
 * time is all the card needs).
 */
export function stashClaimCongrats(username: string, wallet: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(
      CLAIM_CONGRATS_LS_KEY,
      JSON.stringify({
        username: username.toLowerCase(),
        wallet: wallet.toLowerCase(),
        atMs: Date.now(),
        seen: false,
      }),
    );
  } catch {
    /* private mode / quota — the page still works, just no congrats card */
  }
}

/**
 * Read the pending congrats flag. Returns the record, or null when there
 * is no flag, it expired, it is malformed, or it belongs to a different
 * wallet. Stale/malformed entries are consumed silently so they can never
 * surprise the user later; a wallet mismatch is NOT consumed (the rightful
 * wallet may come back in the same browser).
 */
export function readClaimCongrats(
  nowMs: number,
  wallet?: string,
): ClaimCongratsRecord | null {
  const s = storage();
  if (!s) return null;
  let raw: string | null = null;
  try {
    raw = s.getItem(CLAIM_CONGRATS_LS_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  const rec = parseRecord(raw);
  if (!rec) {
    try {
      s.removeItem(CLAIM_CONGRATS_LS_KEY);
    } catch {
      /* noop */
    }
    return null;
  }
  if (rec.atMs > 0 && nowMs - rec.atMs > CLAIM_CONGRATS_TTL_MS) {
    try {
      s.removeItem(CLAIM_CONGRATS_LS_KEY);
    } catch {
      /* noop */
    }
    return null;
  }
  // Wallet-bound: never congratulate the wrong wallet after a switch.
  if (
    wallet &&
    rec.wallet &&
    rec.wallet.toLowerCase() !== wallet.toLowerCase()
  ) {
    return null;
  }
  return rec;
}

/**
 * Mark the pending flag as seen (the card has been displayed). Writes the
 * record back with seen=true. Best-effort — never throws.
 */
export function markClaimCongratsSeen(): void {
  const s = storage();
  if (!s) return;
  try {
    const raw = s.getItem(CLAIM_CONGRATS_LS_KEY);
    if (!raw) return;
    const rec = parseRecord(raw);
    if (!rec) return;
    rec.seen = true;
    s.setItem(CLAIM_CONGRATS_LS_KEY, JSON.stringify(rec));
  } catch {
    /* noop */
  }
}

/** Drop the pending flag entirely (used in tests / edge cleanup). */
export function clearClaimCongrats(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(CLAIM_CONGRATS_LS_KEY);
  } catch {
    /* noop */
  }
}
