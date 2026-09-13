/**
 * /api/agents/directory route tests: IP gate + result cache.
 *
 * The mirror-node fetch is stubbed (no network); the KV store is the
 * real in-memory store, cleared between tests. Auth is not involved —
 * this is a public directory — but the per-IP gate and the cache are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getKvStore } from "@/lib/server/store";

import { GET } from "./route";

const EMPTY_LOGS = {
  json: async () => ({ logs: [] }),
  ok: true,
};

function req(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/agents/directory${query}`, {
    method: "GET",
  });
}

beforeEach(async () => {
  await getKvStore().clearPrefix("vs:iprl:");
  await getKvStore().clearPrefix("agents:directory:");
  vi.stubGlobal("fetch", vi.fn(async () => EMPTY_LOGS));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/agents/directory guardrails", () => {
  it("serves the directory and caches the result (one mirror-node fetch)", async () => {
    const first = await GET(req());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ agents: [], count: 0 });
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);

    const second = await GET(req());
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ agents: [], count: 0 });
    // Cache hit — no second mirror-node fan-out.
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  it("429s after 60 requests per IP per hour", async () => {
    let last = 200;
    for (let i = 0; i < 61; i++) {
      const res = await GET(req(`?n=${i}`));
      last = res.status;
      expect([200, 429]).toContain(res.status);
    }
    expect(last).toBe(429);
    const body = (await (await GET(req("?final"))).json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });

  it("keeps serving the directory when the cache backend throws", async () => {
    const kv = getKvStore();
    vi.spyOn(kv, "get").mockRejectedValueOnce(new Error("kv down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [], count: 0 });
  });
});
