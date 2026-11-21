/**
 * A Hedera account's REAL EVM address vs its long-zero form.
 *
 * Hedera accounts have two EVM spellings, and only one of them is the
 * address the account actually uses on-chain:
 *
 * - Long-zero (`0x0000…<num>`): what you get by zero-padding the account
 *   number. This IS the EVM address for ED25519-keyed accounts.
 * - Alias (`0x30c6…`, `0x4fb7…`, …): the ECDSA public-key hash. This is
 *   the EVM address for ECDSA-keyed accounts — and HashPack creates ECDSA
 *   keys by default, so this is the common case.
 *
 * The Registry stores `owner = msg.sender`, i.e. the account's REAL EVM
 * address. Comparing a Registry owner against the long-zero derivation
 * therefore reads "not the owner" for every ECDSA wallet — proven live
 * 2026-11-20: account 0.0.10857765 has mirror `evm_address`
 * 0x4fb76eaa5eb6152501e99ca385c21d3dedf4ccca and the live
 * /api/resolve?username=danny returns owner 0x4FB76eaA…, while the
 * long-zero form is 0x0000…a5ad25. The builder's availability check and
 * the blockpage owner check both got this wrong (an owner saw their own
 * page as "taken" / not theirs).
 *
 * The mirror node's `GET /api/v1/accounts/{id}` is the documented source
 * for the real address (`evm_address` field). This module fetches it
 * (short cache, fail-soft to the long-zero form) and compares against
 * both forms, so ED25519 and ECDSA owners both match.
 */

import { canonicalAddress } from "./session-message";

const MIRROR_NODE = "https://mainnet.mirrornode.hedera.com/api/v1";
const ACCOUNT_FETCH_TIMEOUT_MS = 10_000;
const ALIAS_CACHE_TTL_MS = 5 * 60_000;

/** accountId ("0.0.x") -> { evm address (lowercase) | null, fetchedAt }. */
const aliasCache = new Map<string, { evm: string | null; at: number }>();

/** Test helper: clear the alias cache. */
export function clearAccountEvmCache(): void {
  aliasCache.clear();
}

/**
 * The account's real EVM address from the mirror node (`evm_address`):
 * the alias for ECDSA-keyed accounts, the long-zero form for ED25519.
 * Null on any failure — callers fall back to the long-zero derivation,
 * which is still correct for ED25519 accounts.
 */
export async function fetchAccountEvmAddress(
  accountId: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const id = accountId.trim();
  if (!/^0\.0\.\d+$/.test(id)) return null;
  const cached = aliasCache.get(id);
  if (cached && Date.now() - cached.at < ALIAS_CACHE_TTL_MS) return cached.evm;
  // A failed lookup is cached only briefly (30s): a mirror blip must
  // not pin an ECDSA owner to "not the owner" for five minutes, and
  // every keystroke must not hammer a down mirror either.
  const failed = aliasCache.get(`${id}:fail`);
  if (failed && Date.now() - failed.at < 30_000) return null;
  let evm: string | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ACCOUNT_FETCH_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${MIRROR_NODE}/accounts/${encodeURIComponent(id)}`, {
        signal: ctrl.signal,
      });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { evm_address?: unknown } | null;
        const raw = json?.evm_address;
        evm =
          typeof raw === "string" && /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : null;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    evm = null;
  }
  if (evm) {
    aliasCache.set(id, { evm, at: Date.now() });
    aliasCache.delete(`${id}:fail`);
  } else {
    aliasCache.set(`${id}:fail`, { evm: null, at: Date.now() });
  }
  return evm;
}

/**
 * Does the Registry owner address belong to this wallet?
 *
 * `owner` is the 0x address from resolvePage. `account` is the wallet's
 * "0.0.x" id or a 0x address. `aliasEvm` is the wallet's real EVM
 * address from fetchAccountEvmAddress (pass null when unknown — the
 * long-zero form still matches ED25519 owners).
 */
export function isSameOnchainOwner(
  owner: string,
  account: string,
  aliasEvm?: string | null,
): boolean {
  const o = owner.trim().toLowerCase();
  const a = account.trim().toLowerCase();
  if (!o || !a) return false;
  if (o === a) return true;
  if (aliasEvm && o === aliasEvm.trim().toLowerCase()) return true;
  // 0.0.x -> long-zero form (correct for ED25519-keyed accounts).
  if (/^0\.0\.\d+$/.test(a)) {
    const longZero = canonicalAddress(a);
    if (longZero && o === longZero) return true;
  }
  return false;
}
