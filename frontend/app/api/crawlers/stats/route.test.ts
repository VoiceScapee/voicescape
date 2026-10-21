/**
 * Crawler stats route tests — memory store, no network.
 *
 * Seeds the shared store (which falls back to memory in this test env)
 * and verifies the aggregate shape: per-bot totals + per-day breakdown +
 * first/last seen, per-path totals, and that bots/paths with zero
 * activity are omitted. Dates are computed relative to today so the
 * tests never depend on the calendar date. No IPs or raw UAs exist
 * anywhere in the data.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CRAWLER_COUNTER_TTL_MS,
  CRAWLER_META_TTL_MS,
  CRAWLER_PATHS_INDEX_KEY,
  botDayKey,
  botFirstKey,
  botLastKey,
  dayKey,
  pathDayKey,
} from "@/lib/crawlers";
import {
  getKvStore,
  resetKvStoreSingleton,
} from "@/lib/server/store";
import { GET } from "./route";

const DAY_MS = 24 * 3600 * 1000;
const today = (): string => dayKey(new Date());
const yesterday = (): string => dayKey(new Date(Date.now() - DAY_MS));

beforeEach(() => {
  // Force the memory backend: no Upstash, no Valkey in this test env.
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  vi.stubEnv("VALKEY_URL", "");
  vi.stubEnv("REDIS_URL", "");
  resetKvStoreSingleton();
});

async function seed(): Promise<void> {
  const store = getKvStore();
  const d0 = yesterday();
  const d1 = today();
  // GPTBot: 2 hits yesterday, 1 hit today, on two paths.
  await store.incr(botDayKey(d0, "GPTBot"), CRAWLER_COUNTER_TTL_MS);
  await store.incr(botDayKey(d0, "GPTBot"), CRAWLER_COUNTER_TTL_MS);
  await store.incr(botDayKey(d1, "GPTBot"), CRAWLER_COUNTER_TTL_MS);
  await store.incr(pathDayKey(d0, "/llms.txt"), CRAWLER_COUNTER_TTL_MS);
  await store.incr(pathDayKey(d0, "/llms.txt"), CRAWLER_COUNTER_TTL_MS);
  await store.incr(pathDayKey(d1, "/agent.json"), CRAWLER_COUNTER_TTL_MS);
  await store.set(botFirstKey("GPTBot"), d0, CRAWLER_META_TTL_MS);
  await store.set(botLastKey("GPTBot"), d1, CRAWLER_META_TTL_MS);
  await store.set(
    CRAWLER_PATHS_INDEX_KEY,
    JSON.stringify(["/llms.txt", "/agent.json"]),
    CRAWLER_META_TTL_MS,
  );
  // ClaudeBot has only a first-seen key and no counters: rows require
  // total > 0, so it must never appear.
  await store.set(botFirstKey("ClaudeBot"), d0, CRAWLER_META_TTL_MS);
}

describe("GET /api/crawlers/stats", () => {
  it("aggregates per-bot and per-path counts for the requested window", async () => {
    await seed();
    const d0 = yesterday();
    const d1 = today();
    const res = await GET(
      new Request("http://localhost/api/crawlers/stats?days=2"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      days: number;
      totals: { requests: number; bots: number; paths: number };
      byBot: {
        bot: string;
        total: number;
        firstSeen: string | null;
        lastSeen: string | null;
        byDay: Record<string, number>;
      }[];
      byPath: { path: string; total: number; byDay: Record<string, number> }[];
    };
    expect(body.ok).toBe(true);
    expect(body.days).toBe(2);
    expect(body.totals).toEqual({ requests: 3, bots: 1, paths: 2 });
    expect(body.byBot).toEqual([
      {
        bot: "GPTBot",
        total: 3,
        firstSeen: d0,
        lastSeen: d1,
        byDay: { [d0]: 2, [d1]: 1 },
      },
    ]);
    expect(body.byPath).toEqual([
      {
        path: "/llms.txt",
        total: 2,
        byDay: { [d0]: 2, [d1]: 0 },
      },
      {
        path: "/agent.json",
        total: 1,
        byDay: { [d0]: 0, [d1]: 1 },
      },
    ]);
  });

  it("returns empty aggregates (not an error) when nothing was recorded", async () => {
    const res = await GET(new Request("http://localhost/api/crawlers/stats"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      totals: { requests: number };
      byBot: unknown[];
      byPath: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.totals.requests).toBe(0);
    expect(body.byBot).toEqual([]);
    expect(body.byPath).toEqual([]);
  });

  it("clamps days to 1..30", async () => {
    await seed();
    const res = await GET(
      new Request("http://localhost/api/crawlers/stats?days=999"),
    );
    const body = (await res.json()) as { days: number };
    expect(body.days).toBe(30);
    const res2 = await GET(
      new Request("http://localhost/api/crawlers/stats?days=abc"),
    );
    const body2 = (await res2.json()) as { days: number };
    expect(body2.days).toBe(7);
  });
});
