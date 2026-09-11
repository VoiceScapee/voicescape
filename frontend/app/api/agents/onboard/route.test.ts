/**
 * POST /api/agents/onboard tests — plug-and-play agent onboarding.
 * Mocks: auth, rate limit, kv store, registry, mirror node, Pinata.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/rate-limit", () => ({
  ipGate: async () => null,
}));

vi.mock("@/lib/server/townhall/auth", () => ({
  defaultAuthPort: () => ({
    verifySession: async (cred: unknown) => {
      if (cred === "good.token") {
        return {
          ok: true,
          session: {
            address: "0x" + "aa".repeat(20),
            chainId: 295,
            nonce: "0123456789abcdef0123456789abcdef",
            issuedAtMs: 1_000_000,
            expiresAtMs: 9_999_999_999_999,
          },
        };
      }
      return { ok: false, error: "bad session" };
    },
  }),
}));

vi.mock("@/lib/server/store", () => ({
  getKvStore: () => ({ incr: async () => 1 }),
}));

vi.mock("@/lib/server/townhall/registry-check", () => ({
  defaultRegistryPort: () => ({
    isRegistered: async (username: string) => username === "taken-name",
  }),
}));

vi.mock("@/lib/server/townhall/topics", () => ({
  mirrorBaseUrl: () => "https://mainnet.mirrornode.hedera.com",
  townhallNetwork: () => "mainnet",
}));

vi.mock("../../../../lib/server/publish.js", () => ({
  publishPageJson: async () => ({ cid: "bafytest", provider: "pinata" }),
}));

import { POST } from "./route";

const REGISTRY = "0x" + "ab".repeat(20);

function postReq(body: unknown, token?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-vs-session"] = token;
  return new NextRequest("http://localhost/api/agents/onboard", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const GOOD_BODY = {
  name: "Scout-7",
  description: "I watch Hedera topics and post summaries.",
  capabilities: ["research", "summarization"],
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_REGISTRY_ADDRESS = REGISTRY;
  // Mirror-node lookup for the 0x session address → 0.0.x payer id + evm address.
  vi.stubGlobal(
    "fetch",
    async () =>
      ({
        ok: true,
        json: async () => ({ account: "0.0.12345", evm_address: "0x" + "aa".repeat(20) }),
      }) as Response,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_REGISTRY_ADDRESS;
});

describe("POST /api/agents/onboard", () => {
  it("returns 401 without a session", async () => {
    const res = await POST(postReq(GOOD_BODY));
    expect(res.status).toBe(401);
  });

  it("returns 401 for a bad session", async () => {
    const res = await POST(postReq(GOOD_BODY, "bad.token"));
    expect(res.status).toBe(401);
  });

  it("returns 400 when name is missing", async () => {
    const res = await POST(postReq({ ...GOOD_BODY, name: "" }, "good.token"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when description is missing", async () => {
    const res = await POST(postReq({ ...GOOD_BODY, description: "" }, "good.token"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when capabilities is empty", async () => {
    const res = await POST(postReq({ ...GOOD_BODY, capabilities: [] }, "good.token"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid custom username", async () => {
    const res = await POST(
      postReq({ ...GOOD_BODY, username: "BAD NAME!" }, "good.token"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when the username is taken", async () => {
    const res = await POST(
      postReq({ ...GOOD_BODY, username: "taken-name" }, "good.token"),
    );
    expect(res.status).toBe(409);
  });

  it("returns an unsigned registerPage tx with derived username by default", async () => {
    const res = await POST(postReq(GOOD_BODY, "good.token"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.username).toBe("user-12345");
    expect(json.cid).toBe("bafytest");
    expect(json.txType).toBe("ContractExecuteTransaction");
    expect(typeof json.unsignedTxBytes).toBe("string");
    expect((json.unsignedTxBytes as string).length).toBeGreaterThan(100);
    expect(json.pageUrl).toContain("user-12345");
    // HCS-10 discoverability guidance included.
    expect(json.hcs10).toBeDefined();
    expect((json.hcs10 as { steps: string[] }).steps.length).toBeGreaterThan(0);
  });

  it("includes unsigned HCS-10 topic transactions", async () => {
    const res = await POST(postReq(GOOD_BODY, "good.token"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    const hcs10 = json.hcs10 as {
      unsignedTxs: {
        inbound: { unsignedTxBytes: string; txType: string };
        outbound: { unsignedTxBytes: string; txType: string };
      } | null;
    };
    expect(hcs10.unsignedTxs).toBeDefined();
    expect(hcs10.unsignedTxs?.inbound.txType).toBe("TopicCreateTransaction");
    expect(hcs10.unsignedTxs?.outbound.txType).toBe("TopicCreateTransaction");
    expect(hcs10.unsignedTxs?.inbound.unsignedTxBytes.length).toBeGreaterThan(100);
  });

  it("honors a custom username when supplied", async () => {
    const res = await POST(
      postReq({ ...GOOD_BODY, username: "scout-7" }, "good.token"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.username).toBe("scout-7");
  });

  it("returns 503 when the registry is not configured", async () => {
    delete process.env.NEXT_PUBLIC_REGISTRY_ADDRESS;
    const res = await POST(postReq(GOOD_BODY, "good.token"));
    expect(res.status).toBe(503);
  });
});
