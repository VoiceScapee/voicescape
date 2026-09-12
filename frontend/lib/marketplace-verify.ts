/**
 * Seller payout verification for marketplace listings.
 *
 * A Hedera account has two valid EVM writings: the long-zero form
 * (0x0000…009f0eff, derived from 0.0.10424063) and the ECDSA alias form
 * (0x30c6…). Page registration records the wallet's signing address while
 * listings record the long-zero form, so a raw string mismatch is NOT proof
 * of tampering. The check below resolves both sides to Hedera account IDs
 * via the mirror node and compares those instead — same account means the
 * payout provably belongs to the seller's page owner.
 */

/** Mirror-node REST base for a chain key. */
export function mirrorBaseFor(chainKey: string): string {
  return chainKey === "hedera-mainnet"
    ? "https://mainnet.mirrornode.hedera.com/api/v1"
    : "https://testnet.mirrornode.hedera.com/api/v1";
}

/**
 * Resolve an EVM address (long-zero or alias form) to its Hedera account id
 * (0.0.x) via the mirror node. Returns null when it cannot be resolved —
 * never throws.
 */
export async function evmAddressToAccountId(
  evmAddress: string,
  mirrorBase: string,
): Promise<string | null> {
  try {
    // The mirror node accepts both long-zero and alias EVM addresses here.
    const res = await fetch(`${mirrorBase}/accounts/${encodeURIComponent(evmAddress)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { account?: unknown };
    return typeof data.account === "string" ? data.account : null;
  } catch {
    return null;
  }
}

export type PayoutCheck = "match" | "mismatch" | "unknown";

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
