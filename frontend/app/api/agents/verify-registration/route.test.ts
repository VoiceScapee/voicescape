/**
 * /api/agents/verify-registration route tests: input validation, result
 * cache, and the verified verdict. The mirror-node fetch is stubbed (no
 * network); the KV store is the real in-memory store, cleared between
 * tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getKvStore } from "@/lib/server/store";

import { GET } from "./route";

const ACCT = "0.0.123456";

function jsonRes(body: unknown) {
  // Typed as Response so vi.mocked(fetch).mockImplementation accepts it;
  // tests only ever read ok/json.
  return { ok: true, json: async () => body } as unknown as Response;
}

/** Mirror stub matching the verifier's real call pattern. */
function stubMirror(createdTopics: Array<{ id: string; memo: string | null }> = BOTH_TOPICS) {
  const memos = new Map(createdTopics.map((t) => [t.id, t.memo]));
  return async (url: any) => {
    const u = String(url);
    if (u.includes("transactiontype=CONSENSUSCREATETOPIC")) {
      return jsonRes({ transactions: createdTopics.map((t) => ({ entity_id: t.id })) });
    }
    const m = u.match(/\/api\/v1\/topics\/(0\.0\.\d+)/);
    if (m) {
      const id = m[1];
      return jsonRes({ topic_id: id, memo: memos.has(id) ? memos.get(id) : null });
    }
    return jsonRes({});
  };
}

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/agents/verify-registration${query}`, {
    method: "GET",
  });
}

const BOTH_TOPICS = [
  { id: "0.0.11", memo: `hcs-10:0:0:0:${ACCT}` },
  { id: "0.0.12", memo: "hcs-10:0:0:1" },
];

beforeEach(async () => {
  await getKvStore().clearPrefix("vs:iprl:");
  await getKvStore().clearPrefix("agents:verify:");
  vi.stubGlobal("fetch", vi.fn(stubMirror()));
  vi.stubEnv("HCS10_REGISTRY_TOPIC", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/agents/verify-registration", () => {
  it("400s when no identity is given", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/username|accountId/);
  });

  it("400s on a malformed accountId", async () => {
    const res = await GET(req("?accountId=banana"));
    expect(res.status).toBe(400);
  });

  it("returns the verdict and caches it (one mirror-node fetch for two calls)", async () => {
    const first = await GET(req(`?accountId=${ACCT}`));
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.accountId).toBe(ACCT);
    expect(body.verified).toBe(true);
    expect(body.checks.inboundTopic.ok).toBe(true);
    expect(body.checks.outboundTopic.ok).toBe(true);
    expect(body.checks.registryRegistration.status).toBe("unconfigured");
    // 1 creation-history query + 2 per-topic memo lookups.
    expect(vi.mocked(fetch).mock.calls.length).toBe(3);

    const second = await GET(req(`?accountId=${ACCT}`));
    expect(second.status).toBe(200);
    expect((await second.json()).verified).toBe(true);
    // Cache hit — no second mirror-node fan-out.
    expect(vi.mocked(fetch).mock.calls.length).toBe(3);
  });

  it("reports unverified when topics are missing", async () => {
    vi.mocked(fetch).mockImplementation(stubMirror([]));
    const res = await GET(req(`?accountId=${ACCT}`));
    expect(res.status).toBe(200);
    expect((await res.json()).verified).toBe(false);
  });

  it("404s for an unknown username", async () => {
    vi.mocked(fetch).mockImplementation(async (url: any) =>
      String(url).includes("/api/agents/directory")
        ? jsonRes({ agents: [] })
        : stubMirror([])(url),
    );
    const res = await GET(req("?username=nope"));
    expect(res.status).toBe(404);
  });
});
