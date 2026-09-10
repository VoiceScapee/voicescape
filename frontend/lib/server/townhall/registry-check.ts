/**
 * Voicescape Social Town Hall — registry membership check.
 *
 * Only registered page owners may post/vote in v1. Membership is verified
 * by reading the on-chain registry (resolvePage) via eth_call — no wallet
 * needed. Results are cached server-side for 60s to avoid RPC spam.
 *
 * Authorship is cryptographic, not self-asserted: every write endpoint
 * requires a signed wallet session (see ./auth.ts), and the claimed
 * username must resolve on-chain to the session's address
 * (resolveOwner). A signature alone is not enough — the signer must own
 * the page they post as.
 */

import { getActiveChain } from "../../chains";
import { createReadOnlySender, type ResolveResult } from "../../tx";

export interface RegistryPort {
  /** True when the username exists in the on-chain registry. */
  isRegistered(username: string): Promise<boolean>;
  /**
   * The page owner's address as stored on-chain (EVM 0x… form), or null
   * when the username is not registered. Used to bind a signed wallet
   * session to the username it claims — authorship is cryptographic,
   * not self-asserted.
   */
  resolveOwner(username: string): Promise<string | null>;
}

const CACHE_TTL_MS = 60_000;
/**
 * Cap: usernames are attacker-chosen input, so the cache must not grow
 * without bound. Insertion-ordered eviction of the oldest entry.
 */
const CACHE_MAX_ENTRIES = 2000;
const cache = new Map<string, { value: ResolveResult | null; at: number }>();

function cacheSet(key: string, value: ResolveResult | null): void {
  if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { value, at: Date.now() });
}

async function resolveCached(username: string): Promise<ResolveResult | null> {
  const key = username.trim().toLowerCase();
  if (!key) return null;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  let value: ResolveResult | null = null;
  try {
    const sender = createReadOnlySender(getActiveChain());
    const registry = process.env.NEXT_PUBLIC_REGISTRY_ADDRESS;
    if (!registry) throw new Error("NEXT_PUBLIC_REGISTRY_ADDRESS is not set");
    value = await sender.viewResolve(registry, key);
  } catch (e) {
    console.warn(`[townhall] registry check failed for "${key}": ${e instanceof Error ? e.message : String(e)}`);
    value = null;
  }
  cacheSet(key, value);
  return value;
}

export class RealRegistryPort implements RegistryPort {
  async isRegistered(username: string): Promise<boolean> {
    return (await resolveCached(username)) !== null;
  }

  async resolveOwner(username: string): Promise<string | null> {
    const resolved = await resolveCached(username);
    return resolved?.owner ?? null;
  }
}

/** Test helper: clear the module cache. */
export function clearRegistryCache(): void {
  cache.clear();
}

let singleton: RegistryPort | null = null;

export function defaultRegistryPort(): RegistryPort {
  if (!singleton) singleton = new RealRegistryPort();
  return singleton;
}
