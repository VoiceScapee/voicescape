/**
 * Crawler tracker store — fetch-only Upstash REST client.
 *
 * EDGE-SAFE BY DESIGN. This file deliberately does NOT import
 * lib/server/store.ts: that module imports ioredis at top level, which
 * cannot run in the Edge runtime where middleware executes. Instead this
 * file speaks the same Upstash REST protocol directly (INCR + conditional
 * PEXPIRE, SET with PX/NX, GET, pipeline) with plain fetch — the same
 * command semantics as UpstashKvStore, minus the Node dependency.
 *
 * Production uses Upstash (see .env.production.example: only the Upstash
 * REST vars are documented there; VALKEY_URL is the self-hosted
 * alternative, not the production path). If neither Upstash var is set,
 * every function here becomes a silent no-op — the tracker fails open
 * and the visitor's response is never affected.
 *
 * KNOWN LIMIT: if production ever sets VALKEY_URL *without* Upstash
 * vars, middleware writes stop (no REST endpoint to write to) while the
 * stats route falls back to the Valkey-backed store and reads empty.
 * That split shows up immediately as flat-zero 6-hour snapshots — the
 * deploy checklist must confirm Upstash vars are set and VALKEY_URL is
 * unset. If both are ever set, the stats route reads Upstash first (see
 * the stats route), so writes and reads stay on the same backend.
 */

import {
  CRAWLER_COUNTER_TTL_MS,
  CRAWLER_META_TTL_MS,
  CRAWLER_PATHS_INDEX_CAP,
  CRAWLER_PATHS_INDEX_KEY,
  botDayKey,
  botFirstKey,
  botLastKey,
  pathDayKey,
  sanitizePath,
  type CrawlerSignal,
} from "./crawlers";

export interface UpstashEnv {
  url: string;
  token: string;
}

export function upstashEnv(): UpstashEnv | null {
  const url = (process.env.UPSTASH_REDIS_REST_URL ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN ?? "").trim();
  return url && token ? { url, token } : null;
}

async function upstashCmd<T>(env: UpstashEnv, ...args: (string | number)[]): Promise<T> {
  const res = await fetch(env.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    throw new Error(`[crawlers] Upstash request failed with HTTP ${res.status}`);
  }
  const json = (await res.json()) as { result?: T; error?: string };
  if (json.error) throw new Error(`[crawlers] Upstash error: ${json.error}`);
  return json.result as T;
}

async function upstashGet(env: UpstashEnv, key: string): Promise<string | null> {
  return upstashCmd<string | null>(env, "GET", key);
}

/**
 * Pipeline GET for many keys, chunked. Returns a map of key -> value
 * (null when missing). Falls back to sequential GETs if the pipeline
 * endpoint errors — slower, still correct.
 */
export async function upstashGetMany(
  env: UpstashEnv,
  keys: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (keys.length === 0) return out;
  const CHUNK = 500;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    try {
      const res = await fetch(`${env.url}/pipeline`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ commands: chunk.map((k) => ["GET", k]) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as { result?: string | null }[];
      chunk.forEach((k, idx) => out.set(k, rows[idx]?.result ?? null));
    } catch {
      for (const k of chunk) {
        try {
          out.set(k, await upstashGet(env, k));
        } catch {
          out.set(k, null);
        }
      }
    }
  }
  return out;
}

/**
 * Record one AI-system signal. Fail-open: any error (missing env, store
 * down, malformed data) is swallowed by the caller — and also here, so
 * a rejected promise can never surface into a visitor's response.
 *
 * Writes per signal: bot counter, path counter (PEXPIRE only on first
 * sighting, mirroring UpstashKvStore.incr), first-seen (set-if-absent),
 * last-seen (overwrite), and the global path index (best-effort: two
 * concurrent first-sights of one path may race, counters stay correct).
 */
export async function recordCrawlerHit(
  signal: CrawlerSignal,
  day: string,
): Promise<void> {
  const env = upstashEnv();
  if (!env) return;
  const path = sanitizePath(signal.path);
  try {
    const botKey = botDayKey(day, signal.bot);
    const botCount = await upstashCmd<number>(env, "INCR", botKey);
    if (botCount === 1) {
      await upstashCmd(env, "PEXPIRE", botKey, CRAWLER_COUNTER_TTL_MS);
    }
    const pKey = pathDayKey(day, path);
    const pathCount = await upstashCmd<number>(env, "INCR", pKey);
    if (pathCount === 1) {
      await upstashCmd(env, "PEXPIRE", pKey, CRAWLER_COUNTER_TTL_MS);
    }
    await upstashCmd(env, "SET", botFirstKey(signal.bot), day, "PX", CRAWLER_META_TTL_MS, "NX");
    await upstashCmd(env, "SET", botLastKey(signal.bot), day, "PX", CRAWLER_META_TTL_MS);
    const raw = await upstashGet(env, CRAWLER_PATHS_INDEX_KEY);
    let paths: string[] = [];
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        paths = parsed.filter((p): p is string => typeof p === "string");
      }
    } catch {
      paths = [];
    }
    if (!paths.includes(path)) {
      paths.push(path);
      if (paths.length > CRAWLER_PATHS_INDEX_CAP) {
        paths = paths.slice(-CRAWLER_PATHS_INDEX_CAP);
      }
      await upstashCmd(
        env,
        "SET",
        CRAWLER_PATHS_INDEX_KEY,
        JSON.stringify(paths),
        "PX",
        CRAWLER_META_TTL_MS,
      );
    }
  } catch {
    // Fail-open: a store failure must never break, delay, or alter the
    // visitor's response. The hit is simply lost; counters stay correct.
  }
}
