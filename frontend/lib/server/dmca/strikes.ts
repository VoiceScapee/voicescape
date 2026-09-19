/**
 * DMCA repeat-infringer policy — copyright strike tracking.
 *
 * ToS §12 promises that "repeat infringers will have their access
 * terminated." §512(c) requires a repeat-infringer policy that is not
 * only adopted and communicated but *reasonably implemented* — so
 * strikes are tracked server-side and enforced on the write path.
 *
 * Design:
 *  - One strike is recorded per executed DMCA takedown against a wallet
 *    (see app/api/dmca/admin/route.ts, action "takedown").
 *  - DMCA_MAX_STRIKES (env, default 3, clamped to >= 1): a wallet at or
 *    above this count is copyright-suspended — town-hall writes are
 *    blocked (see requireNotRestricted in lib/server/townhall/bans.ts).
 *  - Strike counts key on the canonical wallet address (lowercase 0x),
 *    never on usernames. Strikes are permanent unless cleared on a
 *    successful appeal / counter-notice (clearStrikes, admin-only).
 *  - State lives in the shared KV store (see lib/server/store.ts) so it
 *    survives restarts and is shared across instances. Keys:
 *      dmca:strikes:<canon>   → strike count (TTL: 10 years)
 *
 * Privacy: the only thing stored is a wallet address + count. No names,
 * emails, or other PII — the notice itself (with the reporter's contact
 * info, required by law) is stored separately under app/api/dmca/route.ts.
 */

import { getKvStore } from "../store";
import { canonicalAddress } from "../../session-message";

const STRIKE_KEY_PREFIX = "dmca:strikes:";
/** 10 years in ms — strikes are effectively permanent until cleared. */
const STRIKE_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function strikeKey(wallet: string): string | null {
  const c = canonicalAddress(wallet);
  return c ? `${STRIKE_KEY_PREFIX}${c}` : null;
}

/** Max strikes before suspension. Env-overridable; default 3; never below 1. */
export function getMaxStrikes(): number {
  const raw = (process.env.DMCA_MAX_STRIKES ?? "").trim();
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1) return n;
  return 3;
}

export interface StrikeResult {
  wallet: string;
  strikes: number;
  maxStrikes: number;
  suspended: boolean;
}

export interface CopyrightStatus {
  strikes: number;
  maxStrikes: number;
  suspended: boolean;
}

/**
 * Record one copyright strike for the wallet (one per executed takedown).
 * Returns the new count and whether the wallet is now suspended.
 */
export async function recordStrike(wallet: string, noticeId: string): Promise<StrikeResult> {
  const key = strikeKey(wallet);
  if (!key) throw new Error("recordStrike: invalid wallet address");
  const store = getKvStore();
  const strikes = await store.incr(key, STRIKE_TTL_MS);
  const maxStrikes = getMaxStrikes();
  const suspended = strikes >= maxStrikes;
  console.warn(
    `[dmca] strike #${strikes} for ${key.slice(STRIKE_KEY_PREFIX.length)} (notice ${noticeId}) — ${
      suspended ? "SUSPENDED" : "below threshold"
    }`,
  );
  return { wallet: key.slice(STRIKE_KEY_PREFIX.length), strikes, maxStrikes, suspended };
}

/** Current strike count (0 when none). */
export async function getStrikeCount(wallet: string): Promise<number> {
  const key = strikeKey(wallet);
  if (!key) return 0;
  const raw = await getKvStore().get(key);
  const n = parseInt(raw ?? "0", 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** True when the wallet has reached the strike threshold. */
export async function isCopyrightSuspended(wallet: string): Promise<boolean> {
  return (await getStrikeCount(wallet)) >= getMaxStrikes();
}

/** Full status for admin views and the /api/townhall/me/restriction surface. */
export async function getCopyrightStatus(wallet: string): Promise<CopyrightStatus> {
  const strikes = await getStrikeCount(wallet);
  const maxStrikes = getMaxStrikes();
  return { strikes, maxStrikes, suspended: strikes >= maxStrikes };
}

/**
 * Clear a wallet's strikes (successful appeal / counter-notice).
 * Admin-only callers; the wallet stays recorded in the notice log.
 */
export async function clearStrikes(wallet: string): Promise<void> {
  const key = strikeKey(wallet);
  if (!key) return;
  await getKvStore().del(key);
  console.warn(`[dmca] strikes cleared for ${key.slice(STRIKE_KEY_PREFIX.length)}`);
}
