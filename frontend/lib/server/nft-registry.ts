/**
 * Voicescape NFT registry — the index of HTS collections created through
 * the Voicescape NFT builder (create_nft_drop / finalize_nft_drop).
 *
 * Why this exists: the Hedera mirror node cannot enumerate "collections
 * created through Voicescape" — it knows every token, but not which ones
 * came through our builder. This registry is that index. Entries are
 * POINTERS ONLY (token id + creator + name/symbol as declared at
 * creation); every display surface re-reads the live token state from the
 * mirror node, so the registry can never make a stale collection look
 * different from what the chain says.
 *
 * Written ONLY by finalize_nft_drop, AFTER the creation transaction is
 * verified on the mirror node (fee paid, TokenCreate landed, treasury =
 * the creator). Nothing self-declared ever lands here.
 *
 * Storage: the shared KV store (lib/server/store.ts). Entries carry a
 * 10-year TTL, refreshed on every write — the same durable pattern as
 * webhooks/obligations. The index is a JSON array of token ids under one
 * key (read-modify-write); drops are rare, human-scale events, so the
 * lack of atomic list ops in the KV surface is acceptable here.
 */
import { getKvStore, type KvStore } from "./store";

const TOKEN_KEY_PREFIX = "nft-registry:token:";
const INDEX_KEY = "nft-registry:index";
/** 10 years — registry entries are meant to last (mirrors webhooks.ts). */
const REGISTRY_TTL_MS = 10 * 365 * 24 * 3_600_000;

export interface NftRegistryEntry {
  tokenId: string;
  /** Creator's Hedera account (0.0.x) — the token treasury. */
  creatorAccount: string;
  /** Creator's blockpage username. */
  creatorUsername: string;
  /** Collection name as verified on-chain at finalize time. */
  name: string;
  /** Collection symbol as verified on-chain at finalize time. */
  symbol: string;
  /** ISO-8601 registration time (server clock at finalize). */
  createdAt: string;
}

export interface NftRegistryDeps {
  store?: KvStore;
}

function storeOf(deps: NftRegistryDeps): KvStore {
  return deps.store ?? getKvStore();
}

/**
 * Record a verified collection. Idempotent per token id: re-registering
 * the same token refreshes its entry without duplicating the index.
 * Throws on store transport errors (callers fail closed — a drop whose
 * registry write failed must not report success).
 */
export async function registerNftCollection(
  entry: NftRegistryEntry,
  deps: NftRegistryDeps = {},
): Promise<void> {
  const store = storeOf(deps);
  await store.set(TOKEN_KEY_PREFIX + entry.tokenId, JSON.stringify(entry), REGISTRY_TTL_MS);
  const raw = await store.get(INDEX_KEY);
  let ids: string[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      ids = [];
    }
  }
  if (!ids.includes(entry.tokenId)) ids.push(entry.tokenId);
  await store.set(INDEX_KEY, JSON.stringify(ids), REGISTRY_TTL_MS);
}

/** One registry entry by token id, or null. Never throws. */
export async function getNftRegistryEntry(
  tokenId: string,
  deps: NftRegistryDeps = {},
): Promise<NftRegistryEntry | null> {
  try {
    const raw = await storeOf(deps).get(TOKEN_KEY_PREFIX + tokenId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NftRegistryEntry;
    if (!parsed || typeof parsed.tokenId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * All registered collections, NEWEST first. Entries whose token record
 * has vanished (store expiry/corruption) are skipped silently — the page
 * renders what exists, honestly. Never throws.
 */
export async function listNftRegistry(
  deps: NftRegistryDeps = {},
): Promise<NftRegistryEntry[]> {
  const store = storeOf(deps);
  let ids: string[] = [];
  try {
    const raw = await store.get(INDEX_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    return [];
  }
  const entries = await Promise.all(ids.map((id) => getNftRegistryEntry(id, deps)));
  return entries
    .filter((e): e is NftRegistryEntry => e !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
