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
 * On-chain registry owner type. 0 = HUMAN, 1 = AGENT
 * (matches the VoicescapeRegistry contract interface).
 */
export type PageOwnerType = "human" | "agent";

/** A successfully registered page: its username plus its on-chain owner type. */
export interface RegisteredPage {
  username: string;
  ownerType: PageOwnerType;
}

/**
 * Decode the username (first arg) and ownerType (third arg, uint8) from
 * registerPage calldata. The registry is the on-chain source of truth for
 * whether a page belongs to a human or an AI agent.
 * Null when the calldata isn't a registerPage call or is malformed.
 */
export function decodePageFromCalldata(calldata: string | null | undefined): RegisteredPage | null {
  try {
    if (typeof calldata !== "string" || !calldata.toLowerCase().startsWith(REGISTERPAGE_SELECTOR)) {
      return null;
    }
    const [username, , ownerType] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["string", "string", "uint8", "address", "string"],
      "0x" + calldata.slice(REGISTERPAGE_SELECTOR.length),
    );
    const name = String(username ?? "").trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,32}$/.test(name)) return null;
    const typeNum = typeof ownerType === "bigint" ? Number(ownerType) : Number(ownerType);
    if (typeNum !== 0 && typeNum !== 1) return null;
    return { username: name, ownerType: typeNum === 1 ? "agent" : "human" };
  } catch {
    return null;
  }
}

/**
 * Decode the username (first arg) from registerPage calldata.
 * Null when the calldata isn't a registerPage call or is malformed.
 */
export function decodeUsernameFromCalldata(calldata: string | null | undefined): string | null {
  return decodePageFromCalldata(calldata)?.username ?? null;
}

/**
 * Newest-first scan of an account's registry calls for the latest
 * successful registerPage — returns that page (username + owner type).
 * Null when the account never registered (reverted calls don't count).
 */
export function findLatestRegisteredPage(results: ContractResultShape[]): RegisteredPage | null {
  for (const r of results) {
    if (!r || r.error_message) continue;
    const page = decodePageFromCalldata(r.function_parameters);
    if (page) return page;
  }
  return null;
}

/**
 * Newest-first scan of an account's registry calls for the latest
 * successful registerPage — returns that username. Null when the account
 * never registered (reverted calls don't count).
 */
export function findLatestRegisteredUsername(results: ContractResultShape[]): string | null {
  return findLatestRegisteredPage(results)?.username ?? null;
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
 * (username + on-chain owner type) via the on-chain Registry. Returns null
 * when it owns no page or the lookup fails (never throws — callers treat
 * null as "unknown").
 */
export async function resolvePageForOwner(owner: string): Promise<RegisteredPage | null> {
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
    return findLatestRegisteredPage(results);
  } catch {
    return null;
  }
}

/**
 * Resolve a wallet account ("0.0.x" or "0x…") to its latest registered page
 * username via the on-chain Registry. Returns null when it owns no page or
 * the lookup fails (never throws — callers treat null as "unknown").
 */
export async function resolveUsernameForOwner(owner: string): Promise<string | null> {
  return (await resolvePageForOwner(owner))?.username ?? null;
}
