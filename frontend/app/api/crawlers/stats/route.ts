/**
 * GET /api/crawlers/stats — aggregate-only AI crawler statistics.
 *
 * This is what the 6-hour snapshot cron reads. Aggregate bot stats about
 * public paths are not sensitive, so this route needs no authentication.
 *
 * Returns, for the last N UTC days (?days=, default 7, max 30):
 *   - per-bot totals + per-day breakdown + first/last seen day
 *   - per-path totals + per-day breakdown (paths come from the recorded
 *     path index, so only paths actually seen are ever listed)
 * No IPs, no raw User-Agent strings, no per-request rows — the store
 * never holds them, so this route cannot leak them.
 *
 * Read path: Upstash REST first when its vars are present (the same
 * backend the middleware writes to, so writes and reads can never
 * split-brain); otherwise the shared getKvStore() (Valkey/memory).
 * Fail-open: a store failure returns empty aggregates with ok:true and
 * a "degraded" flag, never a 500 — a snapshot cron must not page anyone
 * because a counter backend hiccuped.
 */
import { NextResponse } from "next/server";
import {
  BOT_PATTERNS,
  UNKNOWN_AGENT,
  botDayKey,
  botFirstKey,
  botLastKey,
  dayKey,
  pathDayKey,
  CRAWLER_PATHS_INDEX_KEY,
} from "@/lib/crawlers";
import {
  upstashEnv,
  upstashGetMany,
} from "@/lib/crawlers-store";
import { getKvStore } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;

function parseDays(raw: string | null): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

function lastNDays(n: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(dayKey(new Date(now.getTime() - i * 24 * 3600 * 1000)));
  }
  return out;
}

function toCount(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

async function readKeys(keys: string[]): Promise<Map<string, string | null>> {
  const env = upstashEnv();
  if (env) {
    try {
      return await upstashGetMany(env, keys);
    } catch {
      // Fall through to the shared store (same backend in production).
    }
  }
  const store = getKvStore();
  const out = new Map<string, string | null>();
  for (const key of keys) {
    try {
      out.set(key, await store.get(key));
    } catch {
      out.set(key, null);
    }
  }
  return out;
}

async function readIndex(): Promise<string[]> {
  const env = upstashEnv();
  if (env) {
    try {
      const raw = await upstashGetMany(env, [CRAWLER_PATHS_INDEX_KEY]);
      const value = raw.get(CRAWLER_PATHS_INDEX_KEY);
      if (value) {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.filter((p): p is string => typeof p === "string");
        }
      }
      return [];
    } catch {
      // Fall through to the shared store.
    }
  }
  try {
    const raw = await getKvStore().get(CRAWLER_PATHS_INDEX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const days = parseDays(url.searchParams.get("days"));
  const dates = lastNDays(days);
  const bots = [...BOT_PATTERNS, UNKNOWN_AGENT];

  let degraded = false;
  let values: Map<string, string | null>;
  try {
    const keys: string[] = [];
    for (const bot of bots) {
      keys.push(botFirstKey(bot), botLastKey(bot));
      for (const date of dates) keys.push(botDayKey(date, bot));
    }
    values = await readKeys(keys);
  } catch {
    degraded = true;
    values = new Map();
  }

  let paths: string[] = [];
  try {
    paths = await readIndex();
  } catch {
    degraded = true;
  }

  let pathValues = new Map<string, string | null>();
  if (paths.length > 0) {
    try {
      const pathKeys: string[] = [];
      for (const path of paths) {
        for (const date of dates) pathKeys.push(pathDayKey(date, path));
      }
      pathValues = await readKeys(pathKeys);
    } catch {
      degraded = true;
    }
  }

  const byBot = bots
    .map((bot) => {
      const byDay: Record<string, number> = {};
      let total = 0;
      for (const date of dates) {
        const count = toCount(values.get(botDayKey(date, bot)));
        byDay[date] = count;
        total += count;
      }
      return {
        bot,
        total,
        firstSeen: values.get(botFirstKey(bot)) ?? null,
        lastSeen: values.get(botLastKey(bot)) ?? null,
        byDay,
      };
    })
    .filter((entry) => entry.total > 0);

  const byPath = paths
    .map((path) => {
      const byDay: Record<string, number> = {};
      let total = 0;
      for (const date of dates) {
        const count = toCount(pathValues.get(pathDayKey(date, path)));
        byDay[date] = count;
        total += count;
      }
      return { path, total, byDay };
    })
    .filter((entry) => entry.total > 0)
    .sort((a, b) => b.total - a.total);

  const totalRequests = byBot.reduce((sum, entry) => sum + entry.total, 0);

  return NextResponse.json(
    {
      ok: true,
      degraded,
      days,
      generatedAt: new Date().toISOString(),
      totals: {
        requests: totalRequests,
        bots: byBot.length,
        paths: byPath.length,
      },
      byBot,
      byPath,
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300",
      },
    },
  );
}
