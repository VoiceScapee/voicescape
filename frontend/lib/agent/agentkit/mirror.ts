/**
 * Shared mirror-node helpers for the Voicescape Agent Kit plugin.
 *
 * All reads go through the public Hedera mainnet mirror node REST API.
 * `ethers` is used for ABI encode/decode ONLY, never as a chain connection
 * (deploy-gate rule). These helpers never sign, spend, or publish — pure reads.
 */
import { AbiCoder, id as keccakId } from "ethers";

export const MIRROR = "https://mainnet.mirrornode.hedera.com/api/v1";

export const REGISTRY_ID = "0.0.10854058";
export const REGISTRY_EVM = "0xd87f8113c5bcc47c40dc26a43ffa9b1629385a58";
export const TIPS_ID = "0.0.10854060";

/** resolvePage(string) — computed, not hardcoded */
export const RESOLVE_PAGE_SELECTOR = keccakId("resolvePage(string)").slice(0, 10);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const abi = AbiCoder.defaultAbiCoder();
export const tinybarToHbar = (t: number | string): number =>
  Number(t) / 100_000_000;

/**
 * EVM address -> Hedera account id ("0.0.x"), or null when the address
 * is not a long-zero form.
 *
 * ROOT FIX (2026-11-22): the old code ran BigInt() over ANY 40 hex
 * chars, so an ECDSA alias address (0x4fb7…) became a bogus
 * "0.0.<astronomical>" that matches no real account. Only a long-zero
 * address (0x0000…<num>) names an account by derivation; an alias must
 * be resolved through the mirror node (see the async
 * evmAddressToAccountId in lib/marketplace-verify.ts). This sync helper
 * cannot do that lookup, so it returns null for aliases — an honest
 * "unknown" — instead of a fabricated id. Callers already treat null
 * as unknown (resolve_blockpage still returns the real ownerEvmAddress,
 * so the alias itself is never lost).
 */
export function evmAddressToAccountId(addr: string): string | null {
  const m = /^0x0{24}([0-9a-fA-F]{16})$/.exec(addr.trim());
  if (!m) return null;
  try {
    return `0.0.${BigInt("0x" + m[1]).toString(10)}`;
  } catch {
    return null;
  }
}

export async function mirrorGet(
  path: string,
  signal?: AbortSignal
): Promise<any> {
  const res = await fetch(`${MIRROR}${path}`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`mirror node GET ${path}: HTTP ${res.status}`);
  return res.json();
}

export async function mirrorContractCall(
  to: string,
  data: string,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch(`${MIRROR}/contracts/call`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      to,
      data,
      estimate: false,
      gas: 15_000_000,
      gasPrice: 1,
      value: 0,
    }),
    signal,
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(
      `mirror node contracts/call: HTTP ${res.status} ${bodyText.slice(0, 300)}`
    );
  }
  const body: any = await res.json();
  if (!body.result)
    throw new Error("mirror node contracts/call: no result field");
  return body.result as string;
}

export { ZERO_ADDRESS };
