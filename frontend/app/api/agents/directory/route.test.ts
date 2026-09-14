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

  it("lists agents from PageRegistered logs — never PageUpdated", async () => {
    // Regression: the route once filtered on the PageUpdated topic hash,
    // which silently emptied the directory. The topic must be the canonical
    // PageRegistered hash from lib/registry-topics.ts.
    const { PAGEREGISTERED_TOPIC, PAGEUPDATED_TOPIC } = await import(
      "@/lib/registry-topics"
    );
    const w = (n: number) => n.toString(16).padStart(64, "0");
    const wStr = (s: string) => {
      const hex = Buffer.from(s, "utf8").toString("hex");
      return w(s.length) + hex.padEnd(64, "0");
    };
    // PageRegistered(string username, address owner, string ipfsHash,
    //   uint8 ownerType, address operator, string purpose) — data layout:
    // [128][1][0][224][len+ipfsHash(64B content)][len+purpose]
    const regData =
      "0x" +
      w(128) +
      w(1) +
      w(0) +
      w(224) +
      w(6) +
      Buffer.from("QmTest", "utf8").toString("hex").padEnd(128, "0") +
      wStr("test purpose");
    const topics = ["0x" + "11".repeat(32), "0x" + "22".repeat(32)];
    const regLog = {
      timestamp: "1789000000.000000000",
      topics: [PAGEREGISTERED_TOPIC, ...topics],
      data: regData,
    };
    const updLog = {
      ...regLog,
      topics: [PAGEUPDATED_TOPIC, ...topics],
    };
    // registerPage(string,uint8,...) calldata: selector + username at offset 32
    const fp =
      "0x12345678" + w(32) + w(4) + Buffer.from("echo", "utf8").toString("hex").padEnd(64, "0");
    vi.mocked(fetch).mockImplementation((async (url: unknown) => {
      const ok = (json: unknown) =>
        ({ ok: true, json: async () => json }) as unknown as Response;
      const u = String(url);
      if (u.includes("/results/logs"))
        return ok({ logs: [updLog, regLog] });
      if (u.includes("/transactions?timestamp="))
        return ok({ transactions: [{ transaction_id: "0.0.1@1234.567" }] });
      if (u.includes("/contracts/results/"))
        return ok({ function_parameters: fp });
      return ok({});
    }) as typeof fetch);
    const res = await GET(req("?t=topic-regression"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: { username: string }[]; count: number };
    expect(body.count).toBe(1);
    expect(body.agents[0].username).toBe("echo");
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
