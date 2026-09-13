/**
 * Reverse page lookup: wallet account -> registered username.
 *
 * The registry contract only maps username -> owner (resolvePage), so to
 * find the page a wallet owns we list that account's calls to the Registry
 * on the official Hedera mirror node (`/contracts/{id}/results?from=…` —
 * the same official source Explore reads) and take the newest successful
 * registerPage call. The username is decoded from the call's
 * function_parameters.
 *
 * Used by the onboarding gate: a wallet that already owns a page on-chain
 * must never replay the "build your first blockpage" wizard just because
 * localStorage is empty on a fresh browser/profile.
 */
import { ethers } from "ethers";

const MIRROR_NODE = "https://mainnet.mirrornode.hedera.com/api/v1";
// Registry 0.0.10854058 (same contract the Explore feed reads).
const REGISTRY_ID = "0.0.10854058";
// registerPage(string,string,uint8,address,string)
const REGISTERPAGE_SELECTOR = "0xc02fdb27";

export interface ContractResultShape {
  function_parameters?: string;
  /** Mirror node sets this on reverted calls; null/empty means success. */
  error_message?: string | null;
}

/**
 * Decode the username (first arg) from registerPage calldata.
 * Null when the calldata isn't a registerPage call or is malformed.
 */
export function decodeUsernameFromCalldata(calldata: string | null | undefined): string | null {
  try {
    if (typeof calldata !== "string" || !calldata.toLowerCase().startsWith(REGISTERPAGE_SELECTOR)) {
      return null;
    }
    const [username] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["string", "string", "uint8", "address", "string"],
      "0x" + calldata.slice(REGISTERPAGE_SELECTOR.length),
    );
    const name = String(username ?? "").trim().toLowerCase();
    return /^[a-z0-9_-]{3,32}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * Newest-first scan of an account's registry calls for the latest
 * successful registerPage — returns that username. Null when the account
 * never registered (reverted calls don't count).
 */
export function findLatestRegisteredUsername(results: ContractResultShape[]): string | null {
  for (const r of results) {
    if (!r || r.error_message) continue;
    const username = decodeUsernameFromCalldata(r.function_parameters);
    if (username) return username;
  }
  return null;
}

/**
 * Mirror-node EVM address for an account id ("0.0.x"); a "0x…" address is
 * used as-is. Null when the input isn't an account or address, or the
 * lookup fails.
 */
async function evmAddressFor(owner: string): Promise<string | null> {
  const v = owner.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return v.toLowerCase();
  if (!/^\d+\.\d+\.\d+$/.test(v)) return null;
  const res = await fetch(`${MIRROR_NODE}/accounts/${v}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => null)) as { evm_address?: unknown } | null;
  const evm = json?.evm_address;
  return typeof evm === "string" && /^0x[0-9a-fA-F]{40}$/.test(evm) ? evm.toLowerCase() : null;
}

/**
 * Resolve a wallet account ("0.0.x" or "0x…") to its latest registered page
 * username via the on-chain Registry. Returns null when it owns no page or
 * the lookup fails (never throws — callers treat null as "unknown").
 */
export async function resolveUsernameForOwner(owner: string): Promise<string | null> {
  try {
    const evm = await evmAddressFor(owner);
    if (!evm) return null;
    const url =
      `${MIRROR_NODE}/contracts/${REGISTRY_ID}/results` +
      `?from=${evm}&order=desc&limit=50`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { results?: unknown } | null;
    const results = Array.isArray(json?.results) ? (json.results as ContractResultShape[]) : [];
    return findLatestRegisteredUsername(results);
  } catch {
    return null;
  }
}
