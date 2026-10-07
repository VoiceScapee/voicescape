/**
 * Claim completion signal tests.
 *
 * The human's wallet signature is the registration: once it confirms
 * on-chain, the server marks the claim "completed" so the agent polling
 * the package status learns the truth instead of waiting on "awaiting_signature"
 * forever (which made agents tell the human "I can't run my blockpage
 * until it's registered" even after the human signed).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/rate-limit", () => ({
  ipGate: async () => null,
}));

const store = new Map<string, unknown>();
let onChainUsernames = new Set<string>();

vi.mock("@/lib/server/claim-packages", () => ({
  getClaimPackage: async (id: string) =>
    id === "a".repeat(32)
      ? { username: "thechomps", claimCode: "ABC123" }
      : id === "c".repeat(32)
        ? { username: "selfbot", claimCode: null, mode: "self", ownerAccountId: "0.0.1234" }
        : null,
}));

vi.mock("@/lib/server/package-status", () => ({
  getPackageStatus: async (_kind: string, id: string) => store.get(id) ?? null,
  setPackageStatus: async (
    _kind: string,
    id: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => {
    store.set(id, { packageId: id, status, updatedAt: Date.now(), ...extra });
  },
}));

vi.mock("@/lib/server/mcp-tools", () => ({
  lookupBlockpage: async (username: string) => ({
    found: onChainUsernames.has(username),
    username,
  }),
}));

import { POST } from "./route";
import { GET } from "../status/route";

const ID = "a".repeat(32);

function postReq(body: unknown): Request {
  return new Request(`http://localhost/api/claim-packages/${ID}/completed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  store.clear();
  onChainUsernames = new Set();
});

describe("POST /api/claim-packages/[id]/completed", () => {
  it("marks completed when the page is registered on-chain", async () => {
    onChainUsernames.add("thechomps");
    const res = await POST(postReq({ transaction_id: "0.0.1@123.456" }), {
      params: Promise.resolve({ id: ID }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.username).toBe("thechomps");
    expect(json.page_url).toContain("thechomps");
    const recorded = store.get(ID) as { status: string };
    expect(recorded.status).toBe("completed");
  });

  it("returns 409 when the page is not on-chain yet (never trusts the client)", async () => {
    const res = await POST(postReq({ transaction_id: "0.0.1@123.456" }), {
      params: Promise.resolve({ id: ID }),
    });
    expect(res.status).toBe(409);
    expect(store.get(ID)).toBeUndefined();
  });

  it("is idempotent: already-completed stays completed", async () => {
    onChainUsernames.add("thechomps");
    store.set(ID, { packageId: ID, status: "completed", username: "thechomps" });
    const res = await POST(postReq({ transaction_id: "0.0.1@123.456" }), {
      params: Promise.resolve({ id: ID }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.already).toBe(true);
  });

  it("rejects unknown ids and missing transaction ids", async () => {
    const bad = await POST(postReq({ transaction_id: "0.0.1@1.1" }), {
      params: Promise.resolve({ id: "b".repeat(32) }),
    });
    expect(bad.status).toBe(404);
    const missing = await POST(postReq({}), {
      params: Promise.resolve({ id: ID }),
    });
    expect(missing.status).toBe(400);
  });

  it("rejects self-mode packages — the browser completion signal never flips them", async () => {
    onChainUsernames.add("selfbot");
    const res = await POST(postReq({ transaction_id: "0.0.1234@123.456" }), {
      params: Promise.resolve({ id: "c".repeat(32) }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(String(json.error)).toMatch(/complete_agent_self_claim/);
    expect(store.get("c".repeat(32))).toBeUndefined();
  });
});

describe("GET /api/claim-packages/[id]/status self-healing", () => {
  it("upgrades awaiting_signature to completed when the page is on-chain", async () => {
    onChainUsernames.add("thechomps");
    store.set(ID, {
      packageId: ID,
      status: "awaiting_signature",
      username: "thechomps",
      transactionId: "0.0.1@123.456",
      updatedAt: Date.now(),
    });
    const res = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: ID }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("completed");
    expect(json.detail as string).toContain("live at");
    // Persisted, so the next poll doesn't re-check.
    const recorded = store.get(ID) as { status: string };
    expect(recorded.status).toBe("completed");
  });

  it("keeps awaiting_signature when the page is not on-chain yet", async () => {
    store.set(ID, {
      packageId: ID,
      status: "awaiting_signature",
      username: "thechomps",
      updatedAt: Date.now(),
    });
    const res = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: ID }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("awaiting_signature");
  });

  it("reports expired when a waiting record's package is gone (24h TTL lapsed)", async () => {
    // "b"*32 has a status record but the mocked getClaimPackage returns
    // null for it — the package expired silently, the web approval page
    // shows "invalid or expired", and the API must agree.
    const goneId = "b".repeat(32);
    store.set(goneId, {
      packageId: goneId,
      status: "awaiting_signature",
      username: "ghostbot",
      updatedAt: Date.now() - 4 * 24 * 3_600_000,
    });
    const res = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: goneId }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("expired");
    expect(json.detail as string).toContain("24h TTL");
    // Persisted, so the next poll doesn't re-derive it.
    const recorded = store.get(goneId) as { status: string };
    expect(recorded.status).toBe("expired");
  });

  it("keeps a terminal completed record even after the package is gone", async () => {
    const goneId = "b".repeat(32);
    store.set(goneId, {
      packageId: goneId,
      status: "completed",
      username: "ghostbot",
      updatedAt: Date.now() - 4 * 24 * 3_600_000,
    });
    const res = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: goneId }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe("completed");
  });
});
