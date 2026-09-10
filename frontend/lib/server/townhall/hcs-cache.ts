/**
 * Voicescape Town Hall — HCS read cache.
 *
 * Mirror-node reads are the hot path: `queryAll()` can issue up to 20 HTTP
 * requests per call and is invoked from 10+ handlers on nearly every API
 * request. This module adds a short-TTL read-through cache in front of the
 * mirror node so repeated reads (chat polling, stream endpoints, board
 * listings) do not hammer the free tier.
 *
 * Backend: the shared KvStore (lib/server/store.ts) — Upstash Redis when
 * UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set, otherwise a
 * process-local in-memory map. Writes go through `set` with a TTL, so no
 * invalidation bookkeeping is needed beyond `invalidateTopic()` on submit.
 *
 * Failure semantics are deliberately FAIL-OPEN, unlike quotas: a cache
 * that cannot be read/written degrades to plain uncached mirror queries.
 * Nothing is gated on the cache, so an outage never breaks town hall —
 * it only makes it slower.
 */

import { createMemoryKvStore, getKvStore, type KvStore } from "../store";

export interface HcsCache {
  /** Read a cached value; null on miss, expiry, or backend error. */
  get<T>(key: string): Promise<T | null>;
  /** Write with TTL. Backend errors are logged and swallowed (fail-open). */
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  /** Drop every cached query for a topic (called after a successful submit). */
  invalidateTopic(topicId: string): Promise<void>;
  /** Test helper: drop the whole cache namespace. */
  clearAll(): Promise<void>;
}

const CACHE_PREFIX = "vs:hcs:";

function cacheKey(key: string): string {
  return `${CACHE_PREFIX}${key}`;
}

export function createHcsCache(kv: KvStore = getKvStore()): HcsCache {
  async function get<T>(key: string): Promise<T | null> {
    let raw: string | null;
    try {
      raw = await kv.get(cacheKey(key));
    } catch (e) {
      console.debug(`[hcs-cache] miss (store error) ${key}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      console.debug(`[hcs-cache] miss (corrupt payload) ${key}`);
      return null;
    }
  }

  async function set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`[hcs-cache] ttlSeconds must be a positive integer, got ${ttlSeconds}`);
    }
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      console.debug(`[hcs-cache] skip (unserializable) ${key}`);
      return;
    }
    try {
      await kv.set(cacheKey(key), json, ttlSeconds * 1000);
    } catch (e) {
      console.debug(`[hcs-cache] set failed (fail-open) ${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function invalidateTopic(topicId: string): Promise<void> {
    try {
      await kv.clearPrefix(`${CACHE_PREFIX}${topicId}:`);
      console.debug(`[hcs-cache] invalidated topic ${topicId}`);
    } catch (e) {
      // Fail-open: worst case, the next TTL expiry refreshes the data.
      console.debug(`[hcs-cache] invalidate failed (fail-open) ${topicId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function clearAll(): Promise<void> {
    await kv.clearPrefix(CACHE_PREFIX);
  }

  return { get, set, invalidateTopic, clearAll };
}

/** A cache over a private in-memory backend — tests and call sites that want process-local behavior. */
export function createMemoryHcsCache(): HcsCache {
  return createHcsCache(createMemoryKvStore());
}

let singleton: HcsCache | null = null;

/** Process-wide HCS cache shared by the API routes. */
export function globalHcsCache(): HcsCache {
  if (!singleton) singleton = createHcsCache(getKvStore());
  return singleton;
}

/** Test helper: reset the singleton so env changes take effect. */
export function resetHcsCacheSingleton(): void {
  singleton = null;
}
