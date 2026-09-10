/**
 * Voicescape — shared key/value store for cross-instance state.
 *
 * The quotas, replay registries, nonce claims, and IP rate limits must be
 * correct across server restarts AND across N server instances. This module
 * provides one minimal atomic surface both backends implement:
 *
 *   - incr(key, ttlMs)      → atomic INCR; sets TTL when the key is created
 *   - setNx(key, val, ttlMs) → atomic claim-or-reject (SET … NX PX)
 *   - set(key, val, ttlMs)  → overwrite with TTL
 *   - get(key)              → value or null
 *   - del(key)              → release a claim
 *   - clearPrefix(prefix)   → test/dev helper (SCAN+DEL on Redis)
 *
 * Backends:
 *   - Upstash Redis (REST): when UPSTASH_REDIS_REST_URL and
 *     UPSTASH_REDIS_REST_TOKEN are both set. Plain HTTPS fetch, no extra
 *     dependency. Upstash free tier (verified 2026-09-10): 500K commands /
 *     month, 256 MB, no credit card required.
 *   - In-memory: when the Upstash vars are absent. Zero setup, correct on
 *     a single instance; a restart wipes state and a second instance does
 *     not share it. One loud boot warning says so.
 *
 * Economics note: store transport errors THROW (fail closed). A quota that
 * cannot be checked must not silently become unlimited — the route answers
 * 503 instead. The in-memory fallback is only chosen when the operator
 * explicitly left the vars unset (single-instance / dev mode).
 */

export interface KvStore {
  /** Atomic increment. Sets `ttlMs` expiry when the key is created. Returns the new count. */
  incr(key: string, ttlMs: number): Promise<number>;
  /** Atomic claim-or-reject: true when this caller created the key. TTL applies from creation. */
  setNx(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Overwrite with TTL. */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Value, or null when missing/expired. */
  get(key: string): Promise<string | null>;
  /** Delete. */
  del(key: string): Promise<void>;
  /** Delete every key starting with `prefix` (tests/dev). */
  clearPrefix(prefix: string): Promise<void>;
}

function assertTtl(ttlMs: number, what: string): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error(`[store] ${what}: ttlMs must be a positive integer, got ${ttlMs}`);
  }
}

/* ------------------------------------------------------------------ */
/* In-memory backend (single instance / dev)                           */
/* ------------------------------------------------------------------ */

interface MemEntry {
  value: string;
  count: number;
  expiresAtMs: number;
}

class MemoryKvStore implements KvStore {
  private readonly entries = new Map<string, MemEntry>();

  private read(key: string, nowMs: number): MemEntry | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      return null;
    }
    return e;
  }

  async incr(key: string, ttlMs: number): Promise<number> {
    assertTtl(ttlMs, "incr");
    const nowMs = Date.now();
    const e = this.read(key, nowMs);
    if (!e) {
      this.entries.set(key, { value: "1", count: 1, expiresAtMs: nowMs + ttlMs });
      return 1;
    }
    e.count += 1;
    e.value = String(e.count);
    return e.count;
  }

  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    assertTtl(ttlMs, "setNx");
    const nowMs = Date.now();
    if (this.read(key, nowMs)) return false;
    this.entries.set(key, { value, count: 1, expiresAtMs: nowMs + ttlMs });
    return true;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    assertTtl(ttlMs, "set");
    const nowMs = Date.now();
    const prev = this.read(key, nowMs);
    this.entries.set(key, { value, count: prev ? prev.count : 1, expiresAtMs: nowMs + ttlMs });
  }

  async get(key: string): Promise<string | null> {
    const e = this.read(key, Date.now());
    return e ? e.value : null;
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async clearPrefix(prefix: string): Promise<void> {
    for (const k of this.entries.keys()) {
      if (k.startsWith(prefix)) this.entries.delete(k);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Upstash Redis backend (REST, zero dependencies)                      */
/* ------------------------------------------------------------------ */

class UpstashKvStore implements KvStore {
  private readonly restUrl: string;
  private readonly token: string;

  constructor(restUrl: string, token: string) {
    this.restUrl = restUrl.replace(/\/+$/, "");
    this.token = token;
  }

  private async cmd<T = unknown>(...args: (string | number)[]): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.restUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
      });
    } catch (e) {
      throw new Error(
        `[store] Upstash request failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!res.ok) {
      throw new Error(`[store] Upstash request failed with HTTP ${res.status}`);
    }
    let json: { result?: T; error?: string };
    try {
      json = (await res.json()) as { result?: T; error?: string };
    } catch {
      throw new Error("[store] Upstash returned a non-JSON response");
    }
    if (json.error) throw new Error(`[store] Upstash error: ${json.error}`);
    return json.result as T;
  }

  async incr(key: string, ttlMs: number): Promise<number> {
    assertTtl(ttlMs, "incr");
    const count = await this.cmd<number>("INCR", key);
    // Only the creator sets the TTL (INCR is atomic, so exactly one caller
    // sees 1). The TTL can race a crash, but every key we incr carries a
    // time-window in its name (UTC day / window epoch), so a TTL-less key
    // is simply never read again — it cannot leak into the next window.
    if (count === 1) {
      await this.cmd("PEXPIRE", key, ttlMs);
    }
    return count;
  }

  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    assertTtl(ttlMs, "setNx");
    const result = await this.cmd<string | null>("SET", key, value, "PX", ttlMs, "NX");
    return result === "OK";
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    assertTtl(ttlMs, "set");
    await this.cmd("SET", key, value, "PX", ttlMs);
  }

  async get(key: string): Promise<string | null> {
    return this.cmd<string | null>("GET", key);
  }

  async del(key: string): Promise<void> {
    await this.cmd("DEL", key);
  }

  async clearPrefix(prefix: string): Promise<void> {
    let cursor = "0";
    do {
      const [next, keys] = await this.cmd<[string, string[]]>(
        "SCAN",
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        100,
      );
      cursor = next;
      if (keys.length > 0) {
        await this.cmd("DEL", ...keys);
      }
    } while (cursor !== "0");
  }
}

/* ------------------------------------------------------------------ */
/* Backend selection (singleton)                                       */
/* ------------------------------------------------------------------ */

let singleton: KvStore | null = null;
let announced = false;

/** Which backend the singleton resolved to (tests/dev introspection). */
export function storeBackendKind(): "upstash" | "memory" {
  const url = (process.env.UPSTASH_REDIS_REST_URL ?? "").trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN ?? "").trim();
  return url && token ? "upstash" : "memory";
}

/**
 * Process-wide shared store. Upstash when both REST vars are set,
 * otherwise in-memory with a single loud boot warning.
 */
export function getKvStore(): KvStore {
  if (!singleton) {
    const url = (process.env.UPSTASH_REDIS_REST_URL ?? "").trim();
    const token = (process.env.UPSTASH_REDIS_REST_TOKEN ?? "").trim();
    if (url && token) {
      singleton = new UpstashKvStore(url, token);
    } else {
      if ((url || token) && !announced) {
        console.warn(
          "[store] WARNING: only one of UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN is set — " +
            "falling back to the in-memory store. Set both for shared quota state.",
        );
      }
      singleton = new MemoryKvStore();
    }
  }
  if (!announced) {
    announced = true;
    if (singleton instanceof MemoryKvStore) {
      console.warn(
        "[store] WARNING: using the in-memory quota/replay store — quotas and replay protection " +
          "reset on restart and are NOT shared across instances. Set UPSTASH_REDIS_REST_URL and " +
          "UPSTASH_REDIS_REST_TOKEN (free tier, no credit card) before multi-instance deployment.",
      );
    } else {
      console.info("[store] shared quota/replay store: Upstash Redis (REST).");
    }
  }
  return singleton;
}

/** Test/dev helper: build a store directly. */
export function createMemoryKvStore(): KvStore {
  return new MemoryKvStore();
}

/** Test helper: reset the singleton so env changes take effect. */
export function resetKvStoreSingleton(): void {
  singleton = null;
  announced = false;
}
