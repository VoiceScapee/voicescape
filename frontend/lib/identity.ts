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
 * Derive a username from an EVM address (fallback when Hedera account ID
 * isn't available). Uses the last 8 hex chars for uniqueness.
 * Returns null for invalid addresses.
 */
export function deriveUsernameFromEvm(evmAddress: string): string | null {
  const addr = evmAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return null;
  const derived = `user-${addr.slice(-8)}`;
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

/* ------------------------------------------------------------------ */
/* On-chain page check: does this wallet already own a page?           */
/* ------------------------------------------------------------------ */

/**
 * Ask the server which page username a wallet account ("0.0.x" or "0x…")
 * owns on-chain (reverse registry lookup — works for vanity names too, not
 * just wallet-derived ones). Returns the username, or null when the account
 * owns no page (HTTP 404). Throws on transport errors so callers can decide
 * how to fail (the onboarding gate fails open: the wizard is skippable).
 */
export async function fetchRegisteredUsername(account: string): Promise<string | null> {
  const res = await fetch(`/api/resolve?owner=${encodeURIComponent(account)}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`page lookup failed (HTTP ${res.status})`);
  const json = (await res.json().catch(() => null)) as { username?: unknown } | null;
  return typeof json?.username === "string" && json.username ? json.username : null;
}
