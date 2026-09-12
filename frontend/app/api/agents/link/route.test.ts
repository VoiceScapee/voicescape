/**
 * POST/GET/DELETE /api/agents/link tests — the full connect flow:
 * sign-in session + one wallet signature → link record + API key,
 * then list, revoke, and tamper rejection.
 *
 * Mocks: rate limit, session verification, registry ownership.
 * Real: link-message crypto (ethers signature), the KV store, key issuance.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { ethers } from "ethers";

const hoisted = vi.hoisted(() => ({
  store: null as null | ReturnType<typeof import("@/lib/server/store").createMemoryKvStore>,
}));

type TestWallet = Pick<ethers.HDNodeWallet, "address" | "signMessage">;

function setTestWallet(wallet: TestWallet) {
  (globalThis as unknown as Record<string, string>).__LINK_TEST_WALLET__ =
    wallet.address.toLowerCase();
}

vi.mock("@/lib/server/rate-limit", () => ({
  ipGate: async () => null,
}));

vi.mock("@/lib/server/townhall/auth", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/server/townhall/auth")>();
  return {
    ...mod,
    defaultAuthPort: () => ({
      verifySession: async (cred: unknown) => {
        if (cred === "good.token") {
          return {
            ok: true,
            session: {
              address: (globalThis as unknown as Record<string, string>).__LINK_TEST_WALLET__,
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
  };
});

vi.mock("@/lib/server/townhall/registry-check", () => ({
  defaultRegistryPort: () => ({
    // Only "test-agent" is onboarded, owned by 0.0.7654321.
    resolveOwner: async (username: string) =>
      username === "test-agent" ? "0.0.7654321" : null,
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

import { POST, GET, DELETE } from "./route";
import { buildLinkMessage } from "@/lib/agent-link-message";
import { generateNonce } from "@/lib/session-message";

const ORIGIN = "https://voicescape.vercel.app";
const AGENT_ACCOUNT = "0.0.7654321";

function req(method: string, body?: unknown, session = true): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) headers["x-vs-session"] = "good.token";
  return new NextRequest("http://localhost/api/agents/link", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/agents/link", () => {
  beforeEach(() => {
    hoisted.store = null;
    process.env.APP_ORIGIN = ORIGIN;
  });

  async function linkOnce(wallet: TestWallet, agentAccountId = AGENT_ACCOUNT) {
    setTestWallet(wallet);
    const message = buildLinkMessage({
      userAddress: wallet.address,
      agentAccountId,
      uri: ORIGIN,
      nonce: generateNonce(),
      issuedAt: new Date().toISOString(),
    });
    const signature = await wallet.signMessage(message);
    return POST(req("POST", { agentAccountId, username: "test-agent", message, signature }));
  }

  it("links with one signature and issues the API key exactly once", async () => {
    const wallet = ethers.Wallet.createRandom();
    const res = await linkOnce(wallet);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok?: boolean; apiKey?: string; username?: string };
    expect(data.ok).toBe(true);
    expect(data.username).toBe("test-agent");
    expect(data.apiKey).toMatch(/^vsak_[0-9a-f]{48}$/);

    // Listing shows the link with a masked hint — never the key.
    const list = await GET(req("GET"));
    const listed = (await list.json()) as { links: Array<{ keyHint: string; username: string; revokedAtMs: number | null }> };
    expect(listed.links).toHaveLength(1);
    expect(listed.links[0].username).toBe("test-agent");
    expect(listed.links[0].keyHint).toMatch(/^vsak_••••/);
    expect(JSON.stringify(listed.links[0])).not.toContain(data.apiKey!);
  });

  it("refuses a second active link for the same agent", async () => {
    const wallet = ethers.Wallet.createRandom();
    expect((await linkOnce(wallet)).status).toBe(200);
    const dup = await linkOnce(wallet);
    expect(dup.status).toBe(409);
  });

  it("rejects a signature that names a different agent account", async () => {
    const wallet = ethers.Wallet.createRandom();
    setTestWallet(wallet);
    const message = buildLinkMessage({
      userAddress: wallet.address,
      agentAccountId: "0.0.9999999",
      uri: ORIGIN,
      nonce: generateNonce(),
      issuedAt: new Date().toISOString(),
    });
    const signature = await wallet.signMessage(message);
    const res = await POST(req("POST", { agentAccountId: AGENT_ACCOUNT, message, signature }));
    expect(res.status).toBe(400);
  });

  it("rejects a signature from a different wallet", async () => {
    const wallet = ethers.Wallet.createRandom();
    const attacker: TestWallet = ethers.Wallet.createRandom();
    setTestWallet(wallet);
    const message = buildLinkMessage({
      userAddress: wallet.address,
      agentAccountId: AGENT_ACCOUNT,
      uri: ORIGIN,
      nonce: generateNonce(),
      issuedAt: new Date().toISOString(),
    });
    const signature = await attacker.signMessage(message);
    const res = await POST(req("POST", { agentAccountId: AGENT_ACCOUNT, message, signature }));
    expect(res.status).toBe(401);
  });

  it("rejects linking an agent page that is not onboarded", async () => {
    const wallet = ethers.Wallet.createRandom();
    const res = await linkOnce(wallet, "0.0.1111111");
    expect(res.status).toBe(403);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/onboard/i);
  });

  it("revokes the link and kills the key", async () => {
    const wallet = ethers.Wallet.createRandom();
    const linked = await linkOnce(wallet);
    const { apiKey } = (await linked.json()) as { apiKey: string };

    const del = await DELETE(req("DELETE", { agentAccountId: AGENT_ACCOUNT }));
    expect(del.status).toBe(200);

    const list = await GET(req("GET"));
    const listed = (await list.json()) as { links: Array<{ revokedAtMs: number | null }> };
    expect(listed.links[0].revokedAtMs).not.toBeNull();

    // The issued key no longer authenticates (checked via links lib).
    const { resolveAgentKeyAuth, sha256Hex } = await import("@/lib/server/agents/links");
    const { getKvStore } = await import("@/lib/server/store");
    const auth = await resolveAgentKeyAuth(
      new Headers({ "x-vs-agent-key": apiKey }),
      getKvStore(),
    );
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.error).toMatch(/revoked/);
    expect(sha256Hex(apiKey)).toHaveLength(64);
  });

  it("requires a session for every method", async () => {
    expect((await GET(req("GET", undefined, false))).status).toBe(401);
    // A fully valid link body without a session still gets 401.
    const wallet = ethers.Wallet.createRandom();
    setTestWallet(wallet);
    const message = buildLinkMessage({
      userAddress: wallet.address,
      agentAccountId: AGENT_ACCOUNT,
      uri: ORIGIN,
      nonce: generateNonce(),
      issuedAt: new Date().toISOString(),
    });
    const signature = await wallet.signMessage(message);
    const noSession = await POST(
      req("POST", { agentAccountId: AGENT_ACCOUNT, message, signature }, false),
    );
    expect(noSession.status).toBe(401);
    expect((await DELETE(req("DELETE", { agentAccountId: AGENT_ACCOUNT }, false))).status).toBe(401);
  });
});
