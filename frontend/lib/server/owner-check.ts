/**
 * Page-owner identity check that survives Hedera's dual address forms.
 *
 * The bug (2026-09-14): the on-chain Registry stores the owner's address in
 * EVM 0x form, but for ECDSA wallets that is the *alias* address derived
 * from the public key (e.g. 0x30c63dc4… for 0.0.10424063) — NOT the
 * long-zero 0x form. Sessions, meanwhile, always carry the long-zero form
 * (see canonicalAddress in lib/session-message.ts). A direct string compare
 * therefore 403s the legitimate page owner every time.
 *
 * Fix: compare directly first (covers long-zero registry owners), then fall
 * back to resolving the session account's mirror-node EVM address — the
 * only source of truth for the alias form. Read-only, no secrets.
 */

import { mirrorBaseUrl } from "./townhall/topics";

/**
 * Derive "0.0.x" from a long-zero EVM address (0x0000…<16 hex>), or null
 * when the address is not long-zero form.
 */
function longZeroToAccountId(addr: string): string | null {
  const m = /^0x0{24}([0-9a-fA-F]{16})$/.exec(addr.trim());
  if (!m) return null;
  try {
    return `0.0.${BigInt("0x" + m[1]).toString(10)}`;
  } catch {
    return null;
  }
}

/**
 * True when the registry owner address and the session address belong to
 * the same Hedera account, in either address form.
 *
 * Never throws — returns false when the comparison cannot be proven.
 */
export async function isPageOwner(
  registryOwner: string,
  sessionAddress: string,
): Promise<boolean> {
  const owner = registryOwner.trim().toLowerCase();
  const session = sessionAddress.trim().toLowerCase();
  if (!owner || !session) return false;
  if (owner === session) return true;

  // The registry may hold the wallet's ECDSA-derived alias while the
  // session holds the long-zero form. Resolve the alias via mirror node.
  const accountId = longZeroToAccountId(session);
  if (!accountId) return false;
  try {
    const res = await fetch(`${mirrorBaseUrl()}/api/v1/accounts/${accountId}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return false;
    const json = (await res.json().catch(() => null)) as {
      evm_address?: unknown;
    } | null;
    const evm = json?.evm_address;
    return typeof evm === "string" && evm.toLowerCase() === owner;
  } catch {
    return false;
  }
}
