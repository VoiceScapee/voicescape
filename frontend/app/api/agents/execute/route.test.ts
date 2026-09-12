/**
 * POST /api/agents/execute — agent API key path.
 *
 * Proves the connected-agent flow end to end at the route level:
 * x-vs-agent-key → linked identity → unsigned tip transaction whose
 * payer (transactionId) is the agent's own Hedera account, plus
 * identity-mismatch, unknown-key, and quota enforcement.
 *
 * Mocks: rate limit, KV store (shared in-memory), registry ownership.
 * Real: key auth, instruction parser, unsigned-tx builders (pure SDK).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  store: null as null | ReturnType<typeof import("@/lib/server/store").createMemoryKvStore>,
}));

vi.mock("@/lib/server/rate-limit", () => ({
  ipGate: async () => null,
}));

vi.mock("@/lib/server/townhall/registry-check", () => ({
  defaultRegistryPort: () => ({
    resolveOwner: async (username: string) => {
      if (username === "test-agent") return "0.0.7654321";
      if (username === "user-10424063") return "0.0.10424063";
      return null;
    },
  }),
}));

vi.mock("@/lib/server/store", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/server/store")>();
  return {
    ...mod,
    getKvStore: () => {
      if (!hoisted.store) hoisted.store = mod.createMemoryKvStore();
      return hoisted.store;
    },
  };
});

import { POST } from "./route";
import { AGENT_KEY_HEADER, createAgentLink } from "@/lib/server/agents/links";
import { getKvStore } from "@/lib/server/store";

const AGENT_ACCOUNT = "0.0.7654321";
const USER = "0x" + "aa".repeat(20);

function req(body: unknown, agentKey?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (agentKey) headers[AGENT_KEY_HEADER] = agentKey;
  return new NextRequest("http://localhost/api/agents/execute", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/agents/execute with x-vs-agent-key", () => {
  let apiKey: string;

  beforeEach(async () => {
    hoisted.store = null;
    process.env.NEXT_PUBLIC_TIPS_ADDRESS = "0x" + "bb".repeat(20);
    const created = await createAgentLink(getKvStore(), {
      userAddress: USER,
      userAddressDisplay: USER,
      agentAccountId: AGENT_ACCOUNT,
      username: "test-agent",
    });
    if (!created.ok) throw new Error("setup failed");
    apiKey = created.apiKey;
  });

  const TIP = { instruction: "tip 5 HBAR to user-10424063", agentId: "test-agent" };

  it("builds an unsigned tip with the agent account as payer", async () => {
    const res = await POST(req(TIP, apiKey));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      unsignedTxBytes?: string;
      description?: string;
      transactionId?: string;
      txType?: string;
    };
    expect(typeof data.unsignedTxBytes).toBe("string");
    expect(data.unsignedTxBytes!.length).toBeGreaterThan(100);
    // The transactionId embeds the payer: the agent pays from its own wallet.
    expect(data.transactionId).toMatch(/^0\.0\.7654321@/);
    expect(data.description).toMatch(/5/);
  });

  it("rejects an agentId that does not match the linked agent", async () => {
    const res = await POST(req({ ...TIP, agentId: "other-agent" }, apiKey));
    expect(res.status).toBe(403);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/test-agent/);
  });

  it("rejects unknown keys and missing auth", async () => {
    const bad = await POST(req(TIP, "vsak_" + "ff".repeat(24)));
    expect(bad.status).toBe(401);
    const none = await POST(req(TIP));
    expect(none.status).toBe(401);
    const noneData = (await none.json()) as { error?: string };
    expect(noneData.error).toMatch(/agent API key/);
  });

  it("enforces the per-key quota at the route level", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await POST(req(TIP, apiKey));
      expect(res.status).toBe(200);
    }
    const limited = await POST(req(TIP, apiKey));
    expect(limited.status).toBe(429);
  });
});
