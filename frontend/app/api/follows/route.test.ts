/**
 * /api/follows route tests: session-gated follow/unfollow.
 *
 * Auth is mocked like app/api/pin/route.test.ts; the registry port is
 * faked (no chain); the KV store is the real in-memory store, cleared
 * between tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SESSION_HEADER } from "@/lib/session-message";
import { getKvStore } from "@/lib/server/store";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0x1111111111111111111111111111111111111111";

vi.mock("@/lib/server/townhall/auth", () => ({
  defaultAuthPort: () => ({
    verifySession: async (cred: unknown) => {
      if (cred === GOOD_TOKEN) {
        return {
          ok: true,
          session: {
            address: ME,
            chainId: 296,
            username: "tester",
            nonce: "n1",
            issuedAtMs: 1_000_000,
            expiresAtMs: 999,
          },
        };
      }
      return { ok: false, error: "missing session: sign in with your wallet" };
    },
  }),
}));

vi.mock("@/lib/server/townhall/registry-check", () => ({
  defaultRegistryPort: () => ({
    isRegistered: async (u: string) => u === "alice" || u === "selfpage",
    resolveOwner: async (u: string) => (u === "alice" ? ALICE : u === "selfpage" ? ME : null),
    resolvePage: async (u: string) =>
      u === "alice"
        ? { owner: ALICE, ownerType: 0 as const }
        : u === "selfpage"
          ? { owner: ME, ownerType: 0 as const }
          : null,
  }),
}));

const GOOD_TOKEN = "slice5follows.testsig";

import { DELETE, GET, POST } from "./route";

function req(method: string, opts: { token?: string; json?: unknown } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.token) headers[SESSION_HEADER] = opts.token;
  return new NextRequest("http://localhost/api/follows", {
    method,
    headers,
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
  });
}

beforeEach(async () => {
  await getKvStore().clearPrefix("follows:");
  await getKvStore().clearPrefix("followers:");
});

describe("auth", () => {
  it("GET 401s with no session", async () => {
    expect((await GET(req("GET"))).status).toBe(401);
  });
  it("POST 401s with no session", async () => {
    expect((await POST(req("POST", { json: { username: "alice" } }))).status).toBe(401);
  });
  it("DELETE 401s with no session", async () => {
    expect((await DELETE(req("DELETE", { json: { username: "alice" } }))).status).toBe(401);
  });
});

describe("POST /api/follows", () => {
  const authed = (json: unknown) => req("POST", { token: GOOD_TOKEN, json });

  it("400s on an invalid username", async () => {
    const res = await POST(authed({ username: "!!" }));
    expect(res.status).toBe(400);
  });

  it("404s on an unregistered username", async () => {
    const res = await POST(authed({ username: "ghost" }));
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/no page is registered/);
  });

  it("400s on self-follow", async () => {
    const res = await POST(authed({ username: "selfpage" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/own page/);
  });

  it("follows and dedupes", async () => {
    const first = await POST(authed({ username: "alice" }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, following: ["alice"] });
    const second = await POST(authed({ username: "Alice" }));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, following: ["alice"] });
  });
});

describe("GET /api/follows", () => {
  it("returns the caller's own list, empty at first", async () => {
    const res = await GET(req("GET", { token: GOOD_TOKEN }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ following: [] });
  });

  it("reflects follows", async () => {
    await POST(req("POST", { token: GOOD_TOKEN, json: { username: "alice" } }));
    const res = await GET(req("GET", { token: GOOD_TOKEN }));
    expect(await res.json()).toEqual({ following: ["alice"] });
  });
});

describe("DELETE /api/follows", () => {
  it("unfollows and is idempotent", async () => {
    await POST(req("POST", { token: GOOD_TOKEN, json: { username: "alice" } }));
    const res = await DELETE(req("DELETE", { token: GOOD_TOKEN, json: { username: "alice" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, following: [] });
    const again = await DELETE(req("DELETE", { token: GOOD_TOKEN, json: { username: "alice" } }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, following: [] });
  });
});
