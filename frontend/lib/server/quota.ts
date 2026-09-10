/**
 * Voicescape — per-wallet daily quota buckets, backed by the shared store.
 *
 * Economics guard: several server actions cost the platform real money per
 * call (Pinata allowance per pin, operator-paid HCS submits for fee-free
 * town-hall writes). A signed-in wallet gets N free uses per UTC day; beyond that the route answers 429
 * until the next UTC midnight. Session gating stops anonymous callers,
 * this stops an authenticated wallet burning unlimited credits.
 *
 * Correctness across restarts/instances comes from lib/server/store.ts:
 * when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set, every
 * bucket lives in shared Redis with atomic INCR (one command per consume,
 * plus one PEXPIRE when the day's key is created). When unset, the
 * in-memory fallback keeps single-instance/dev working with zero setup —
 * with the documented caveat that a restart wipes counters and a second
 * instance does not share them.
 *
 * Semantic note: the increment happens atomically BEFORE the limit check,
 * so a refused call leaves `used` above `limit` in the 429 body. The
 * economics guarantee is unchanged: 429 is returned before ANY platform
 * spend, and the counter never grants more than `limit` allowed calls.
 *
 * Per-wallet, not per-human: a Sybil with many wallets gets N × wallets.
 * This bounds loss to N × (cost per call) per wallet per day; per-IP rate
 * limits (lib/server/rate-limit.ts) add a second bound in front.
 */

import { createMemoryKvStore, getKvStore, type KvStore } from "./store";

export interface QuotaResult {
  /** True when the call is within quota. */
  allowed: boolean;
  /** Units consumed today in this bucket (the refused call is included in the count). */
  used: number;
  /** The daily limit that applied. */
  limit: number;
  /** ISO-8601 of the next UTC midnight, when the bucket resets. */
  resetsAt: string;
}

export interface QuotaStore {
  /**
   * Try to consume one unit from a (bucket, key) pair.
   * Atomically increments; `allowed` is false once the count exceeds the
   * limit. Refused calls are reported 429 BEFORE any platform spend.
   */
  consume(bucket: string, key: string, limit: number, now?: Date): Promise<QuotaResult>;
  /** Test-only: empty every bucket. */
  clearAll(): Promise<void>;
}

/** "YYYY-MM-DD" in UTC — the daily bucket key. Pure, unit-testable. */
export function utcDayKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** ISO-8601 timestamp of the next UTC midnight after `now`. Pure. */
export function nextUtcMidnightIso(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.toISOString();
}

/**
 * Read a numeric quota limit from env, falling back to `fallback` on
 * missing/garbage/negative input. Pure, unit-testable.
 */
export function quotaLimitFromEnv(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number {
  const raw = env[name];
  if (raw && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    if (Number.isSafeInteger(n) && n >= 0) return n;
  }
  return fallback;
}

function quotaKey(bucket: string, key: string, day: string): string {
  return `vs:quota:${bucket}:${key}:${day}`;
}

/** Build a quota store over any KvStore (the global one by default). */
export function createQuotaStore(kv: KvStore = getKvStore()): QuotaStore {
  async function consume(bucket: string, key: string, limit: number, now: Date = new Date()): Promise<QuotaResult> {
    const day = utcDayKey(now);
    const resetsAt = nextUtcMidnightIso(now);
    const ttlMs = Date.parse(resetsAt) - now.getTime();
    const count = await kv.incr(quotaKey(bucket, key, day), ttlMs);
    return { allowed: count <= limit, used: count, limit, resetsAt };
  }

  async function clearAll(): Promise<void> {
    await kv.clearPrefix("vs:quota:");
  }

  return { consume, clearAll };
}

/**
 * A quota store over a private in-memory backend — for tests and for
 * call sites that explicitly want process-local behavior.
 */
export function createMemoryQuotaStore(): QuotaStore {
  return createQuotaStore(createMemoryKvStore());
}

/**
 * Process-wide quota store shared by the API routes. Each route picks its
 * own bucket name (e.g. "vibecode", "pin:json", "pin:audio",
 * "townhall:free-writes") and env-tuned limit.
 */
export function globalQuotaStore(): QuotaStore {
  return createQuotaStore(getKvStore());
}

/** Shape of the 429 JSON body routes return on quota exhaustion. */
export function quotaExceededBody(result: QuotaResult, message: string): Record<string, unknown> {
  return { error: message, limit: result.limit, resetsAt: result.resetsAt };
}
