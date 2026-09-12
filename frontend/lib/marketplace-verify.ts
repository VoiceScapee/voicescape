/**
 * Seller payout verification for marketplace listings.
 *
 * A Hedera account can appear in three writings: the "0.0.x" id, the
 * long-zero EVM form (0x0000…009f0eff, derived from 0.0.10424063), and — for
 * accounts with an ECDSA wallet key — the alias EVM form (0x30c6…), which is
 * the account's canonical on-chain EVM address. Page registration records
 * the wallet's signing (alias) address while listings record the long-zero
 * form, so a raw string mismatch is NOT proof of tampering. The check below
 * resolves both sides to Hedera account IDs and compares those instead.
 *
 * CRITICAL (proven on mainnet 2026-09-12): the long-zero form is for
 * *identification* only. A contract CALL with value to the long-zero form
 * does NOT reach the account (buyListing reverted TipFailed); the alias
 * form works. Never use a long-zero address as a payment destination —
 * always pay the registry-resolved owner address.
 */

import { longZeroToAccountId } from "./session-message";

/** Mirror-node REST base for a chain key. */
export function mirrorBaseFor(chainKey: string): string {
  return chainKey === "hedera-mainnet"
    ? "https://mainnet.mirrornode.hedera.com/api/v1"
    : "https://testnet.mirrornode.hedera.com/api/v1";
}

/**
 * Resolve an EVM address to its Hedera account id (0.0.x).
 * - "0.0.x" and long-zero form derive locally (no network). NOTE: the
 *   Hedera mirror node REJECTS long-zero EVM addresses
 *   ("Invalid parameter: idOrAliasOrEvmAddress", verified 2026-09-12), so
 *   long-zero must be derived from its packed bytes, never queried.
 * - Alias (0x30c6…) form resolves via the mirror node.
 * Returns null when it cannot be resolved — never throws.
 */
export async function evmAddressToAccountId(
  evmAddress: string,
  mirrorBase: string,
): Promise<string | null> {
  const trimmed = evmAddress.trim();
  // "0.0.x" passes through; long-zero derives from its packed bytes.
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) return trimmed;
  const derived = longZeroToAccountId(trimmed);
  if (derived) return derived;
  try {
    // Alias-form EVM addresses resolve via the mirror node.
    const res = await fetch(`${mirrorBase}/accounts/${encodeURIComponent(trimmed)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { account?: unknown };
    return typeof data.account === "string" ? data.account : null;
  } catch {
    return null;
  }
}

export type PayoutCheck = "match" | "mismatch" | "unknown";

/**
 * Should the Buy button be hard-blocked?
 *
 * Blocked on a proven "mismatch" (payout does not belong to the seller's
 * registered page — the purchase must not proceed) AND while the check is
 * still "checking" (verification in flight — firing the tx before it
 * resolves could burn gas on a doomed purchase).
 *
 * "unknown" (check couldn't run) and "idle"/"match" do not block: "unknown"
 * is not evidence of tampering, and the server-side buy-verify endpoint
 * re-checks authoritatively before any transaction is built.
 */
export function isBuyBlocked(check: "idle" | "checking" | PayoutCheck): boolean {
  return check === "mismatch" || check === "checking";
}

/**
 * Does the listing's payout address belong to the seller's registered page
 * owner?
 *
 * Fast path: exact (case-insensitive) string match — no network needed.
 * Slow path: both addresses resolve to the same Hedera account via the
 * mirror node.
 *
 * "unknown" means the check could not run (mirror node unreachable, address
 * unresolvable) — it is NOT evidence of tampering, so callers must not treat
 * it as a mismatch.
 */
export async function checkPayoutBelongsToOwner(
  payoutEvm: string,
  registryOwner: string,
  mirrorBase: string,
): Promise<PayoutCheck> {
  if (payoutEvm.toLowerCase() === registryOwner.toLowerCase()) return "match";
  const [payoutAcct, ownerAcct] = await Promise.all([
    evmAddressToAccountId(payoutEvm, mirrorBase),
    evmAddressToAccountId(registryOwner, mirrorBase),
  ]);
  if (!payoutAcct || !ownerAcct) return "unknown";
  return payoutAcct === ownerAcct ? "match" : "mismatch";
}
