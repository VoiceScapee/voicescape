/**
 * Crawler store tests — mocked fetch, no network.
 *
 * Verifies the Upstash REST command sequence recordCrawlerHit sends:
 * INCR + conditional PEXPIRE per counter, first-seen set-if-absent,
 * last-seen overwrite, and the best-effort path index (written only when
 * the path is new). Also verifies fail-open behavior: no env vars means
 * no fetch calls at all, and a store error never rejects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordCrawlerHit, upstashEnv } from "./crawlers-store";
import { CRAWLER_PATHS_INDEX_KEY } from "./crawlers";

type Call = { url: string; body: unknown };

function installFetch(handler: (args: unknown[]) => unknown): Call[] {
  const calls: Call[] = [];
  const mock = vi.fn(async (url: string, init: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    const result = handler(Array.isArray(body) ? body : []);
    return {
      ok: true,
      json: async () => ({ result }),
    } as Response;
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

beforeEach(() => {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("upstashEnv", () => {
  it("returns null when either var is missing", () => {
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    expect(upstashEnv()).toBeNull();
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    expect(upstashEnv()).toBeNull();
  });

  it("trims and strips trailing slashes", () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io///");
    expect(upstashEnv()).toEqual({
      url: "https://example.upstash.io",
      token: "test-token",
    });
  });
});

describe("recordCrawlerHit", () => {
  it("writes counters, first/last seen, and a new path index entry", async () => {
    const calls = installFetch((args) => {
      if (args[0] === "INCR") return 1;
      if (args[0] === "GET") return null;
      if (args[0] === "SET" && args.includes("NX")) return "OK";
      return "OK";
    });

    await recordCrawlerHit({ bot: "GPTBot", path: "/llms.txt" }, "2026-10-21");

    const bodies = calls.map((c) => c.body as unknown[]);
    expect(bodies).toContainEqual(["INCR", "crawler:v1:day:2026-10-21:bot:GPTBot"]);
    expect(bodies).toContainEqual([
      "PEXPIRE",
      "crawler:v1:day:2026-10-21:bot:GPTBot",
      30 * 24 * 3600 * 1000,
    ]);
    expect(bodies).toContainEqual([
      "INCR",
      "crawler:v1:day:2026-10-21:path:%2Fllms.txt",
    ]);
    expect(bodies).toContainEqual([
      "SET",
      "crawler:v1:bot:GPTBot:first",
      "2026-10-21",
      "PX",
      365 * 24 * 3600 * 1000,
      "NX",
    ]);
    expect(bodies).toContainEqual([
      "SET",
      "crawler:v1:bot:GPTBot:last",
      "2026-10-21",
      "PX",
      365 * 24 * 3600 * 1000,
    ]);
    const indexSet = bodies.find(
      (b) => b[0] === "SET" && b[1] === CRAWLER_PATHS_INDEX_KEY,
    ) as unknown[];
    expect(JSON.parse(indexSet[2] as string)).toEqual(["/llms.txt"]);
  });

  it("skips PEXPIRE when the counter already existed, and skips the index write when the path is known", async () => {
    const calls = installFetch((args) => {
      if (args[0] === "INCR") return 5;
      if (args[0] === "GET") return JSON.stringify(["/llms.txt"]);
      return "OK";
    });

    await recordCrawlerHit({ bot: "GPTBot", path: "/llms.txt" }, "2026-10-21");

    const bodies = calls.map((c) => c.body as unknown[]);
    expect(bodies.filter((b) => b[0] === "PEXPIRE")).toEqual([]);
    expect(
      bodies.filter((b) => b[0] === "SET" && b[1] === CRAWLER_PATHS_INDEX_KEY),
    ).toEqual([]);
  });

  it("makes no fetch calls when Upstash is not configured", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const calls = installFetch(() => 1);
    await recordCrawlerHit({ bot: "GPTBot", path: "/" }, "2026-10-21");
    expect(calls).toEqual([]);
  });

  it("never rejects, even when the store is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    await expect(
      recordCrawlerHit({ bot: "GPTBot", path: "/" }, "2026-10-21"),
    ).resolves.toBeUndefined();
  });
});
