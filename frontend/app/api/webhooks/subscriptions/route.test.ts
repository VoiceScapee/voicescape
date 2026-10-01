/**
 * POST/GET /api/webhooks/subscriptions route tests: auth gates, page-owner
 * requirement, input validation, list/delete round-trips.
 *
 * Auth + registry are mocked; the KV store is the real in-memory backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getKvStore } from "@/lib/server/store";

import { DELETE } from "./[id]/route";
import { GET, POST } from "./route";

vi.mock("@/lib/server/rate-limit", () => ({
  ipGate: async () => null,
}));

const OWNER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

vi.mock("@/lib/server/townhall/auth", () => ({
  defaultAuthPort: () => ({
    verifySession: async (cred: unknown) => {
      if (cred === "good.token") {
        return {
          ok: true,
          session: {
            address: OWNER_A,
            chainId: 295,
            nonce: "0123456789abcdef0123456789abcdef",
            expiresAtMs: 9_999_999_999_999,
          },
        };
      }
      if (cred === "other.token") {
        return {
          ok: true,
          session: {
            address: OWNER_B,
            chainId: 295,
            nonce: "fedcba9876543210fedcba9876543210",
            expiresAtMs: 9_999_999_999_999,
          },
        };
      }
      return { ok: false, error: "invalid session token" };
    },
  }),
}));

vi.mock("@/lib/registry-reverse", () => ({
  // OWNER_A owns a page; OWNER_B does not.
  resolveUsernameForOwner: async (address: string) =>
    address.toLowerCase() === OWNER_A ? "owner-a-page" : null,
}));

function req(method: string, body?: unknown, session?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (session) headers["x-vs-session"] = session;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest("http://localhost/api/webhooks/subscriptions", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function deleteReq(id: string, session?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (session) headers["x-vs-session"] = session;
  return new NextRequest(`http://localhost/api/webhooks/subscriptions/${id}`, { method: "DELETE", headers });
}

beforeEach(async () => {
  await getKvStore().clearPrefix("webhook:");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/webhooks/subscriptions", () => {
  it("401 without a session", async () => {
    const res = await POST(req("POST", { url: "https://x.example/", events: ["tip"] }));
    expect(res.status).toBe(401);
  });

  it("401 with a bad session", async () => {
    const res = await POST(req("POST", { url: "https://x.example/", events: ["tip"] }, "bad.token"));
    expect(res.status).toBe(401);
  });

  it("403 when the wallet owns no registered page", async () => {
    const res = await POST(req("POST", { url: "https://x.example/", events: ["tip"] }, "other.token"));
    expect(res.status).toBe(403);
  });

  it("400 for non-https and bad event lists", async () => {
    const bad1 = await POST(req("POST", { url: "http://x.example/", events: ["tip"] }, "good.token"));
    expect(bad1.status).toBe(400);
    const bad2 = await POST(req("POST", { url: "https://x.example/", events: ["bogus"] }, "good.token"));
    expect(bad2.status).toBe(400);
    const bad3 = await POST(req("POST", { url: "https://127.0.0.1/", events: ["tip"] }, "good.token"));
    expect(bad3.status).toBe(400);
  });

  it("201 with the secret shown once", async () => {
    const res = await POST(
      req("POST", { url: "https://hooks.example.com/ev", events: ["tip"] }, "good.token"),
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.subscription).toMatchObject({
      url: "https://hooks.example.com/ev",
      events: ["tip"],
    });
    expect(json.subscription.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.secret).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("GET /api/webhooks/subscriptions", () => {
  it("401 without a session", async () => {
    expect((await GET(req("GET"))).status).toBe(401);
  });

  it("lists only the caller's subscriptions, never the secret", async () => {
    await POST(req("POST", { url: "https://a.example.com/", events: ["tip"] }, "good.token"));
    const res = await GET(req("GET", undefined, "good.token"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptions).toHaveLength(1);
    expect(json.subscriptions[0]).not.toHaveProperty("secret");
    // The other wallet sees nothing.
    const other = await GET(req("GET", undefined, "other.token"));
    expect((await other.json()).subscriptions).toHaveLength(0);
  });
});

describe("DELETE /api/webhooks/subscriptions/:id", () => {
  it("401 without a session", async () => {
    const res = await DELETE(deleteReq("nope"), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(401);
  });

  it("deletes the caller's own subscription; 404 for unknown or others'", async () => {
    const created = await POST(req("POST", { url: "https://a.example.com/", events: ["tip"] }, "good.token"));
    const { id } = (await created.json()).subscription;

    const gone = await DELETE(deleteReq(id, "other.token"), { params: Promise.resolve({ id }) });
    expect(gone.status).toBe(404);

    const ok = await DELETE(deleteReq(id, "good.token"), { params: Promise.resolve({ id }) });
    expect(ok.status).toBe(200);

    const again = await DELETE(deleteReq(id, "good.token"), { params: Promise.resolve({ id }) });
    expect(again.status).toBe(404);
  });
});
