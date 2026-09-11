/**
 * Wallet-derived page identity (KISS onboarding).
 *
 * The wallet address IS the identity. A wallet's default page username is
 * derived deterministically from its Hedera account id:
 *
 *   0.0.10424063 -> user-10424063
 *
 * Custom (vanity) names like "0xcreator" are an optional upgrade claimed
 * later — never a blocker to getting a page live.
 */

const USERNAME_RE = /^[a-z0-9-]{3,24}$/;
const ACCOUNT_ID_RE = /^0\.0\.\d{1,20}$/;

/** True when the value fits the on-chain username charset (lowercase). */
export function isValidUsername(name: string): boolean {
  return USERNAME_RE.test(name);
}

/** True when the value looks like a Hedera account id (0.0.x). */
export function isAccountId(input: string): boolean {
  return ACCOUNT_ID_RE.test(input.trim());
}

/**
 * Derive a wallet's default page username from its Hedera account id.
 * Returns null when the account id can't produce a valid username
 * (non-Hedera wallets, absurdly long ids).
 */
export function deriveUsername(accountId: string): string | null {
  const id = accountId.trim();
  if (!ACCOUNT_ID_RE.test(id)) return null;
  const derived = `user-${id.slice(4)}`;
  return USERNAME_RE.test(derived) ? derived : null;
}

/**
 * Normalize a page URL slug. Account ids (0.0.10424063) map to their
 * derived username (user-10424063); anything else passes through
 * trimmed and lowercased.
 */
export function normalizeUsername(input: string): string {
  const v = input.trim().toLowerCase();
  if (ACCOUNT_ID_RE.test(v)) return deriveUsername(v) ?? v;
  return v;
}

/* ------------------------------------------------------------------ */
/* Vanity names: claimed custom names, remembered per wallet.          */
/* ------------------------------------------------------------------ */

function vanityKey(wallet: string): string {
  return `vs-vanity:${wallet.trim().toLowerCase()}`;
}

/** The custom name this wallet claimed before (if any). */
export function getVanityName(wallet: string): string | null {
  try {
    const v = localStorage.getItem(vanityKey(wallet));
    return v && isValidUsername(v) ? v : null;
  } catch {
    return null;
  }
}

/** Remember the custom name this wallet claimed. */
export function setVanityName(wallet: string, name: string): void {
  try {
    localStorage.setItem(vanityKey(wallet), name.trim().toLowerCase());
  } catch {
    /* storage unavailable — the claim itself is on-chain, this is a nicety */
  }
}

/** Forget the remembered custom name for this wallet. */
export function clearVanityName(wallet: string): void {
  try {
    localStorage.removeItem(vanityKey(wallet));
  } catch {
    /* ignore */
  }
}
