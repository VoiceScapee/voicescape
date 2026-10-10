/**
 * Forever-session tests: sessions never expire by time — they stay valid
 * until the user signs out, which bumps the wallet's revocation generation
 * and kills every outstanding token. Covers: far-future issuance, the
 * logout-kills-token flow, backward compatibility for pre-generation
 * tokens, generation mismatch, fail-closed store behavior, and the
 * short-lived login challenge window. No network — the generation KV is
 * a mock store.
 */
import { createHmac } from "crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LOGIN_CHALLENGE_WINDOW_MS,
  SESSION_TTL_MS,
  buildSignInMessage,
  generateNonce,
  validateSignInMessage,
} from "../../session-message";
import type { KvStore } from "../store";
import {
  bumpSessionVersion,
  getSessionVersion,
  issueSessionToken,
  sessionVersionKey,
  verifySessionToken,
} from "./auth";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const CHAIN_ID = 296;
const ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const ORIGIN = "https://voicescape.app";

function mockStore() {
  const m = new Map<string, string>();
  const store = {
    async get(k: string) {
      return m.has(k) ? m.get(k)! : null;
    },
    async set(k: string, v: string) {
      m.set(k, v);
    },
    async incr(k: string) {
      const n = (m.has(k) ? Number.parseInt(m.get(k)!, 10) : 0) + 1;
      m.set(k, String(n));
      return n;
    },
    async del(k: string) {
      m.delete(k);
    },
    _map: m,
  };
  return store as unknown as KvStore & { _map: Map<string, string> };
}

function issue(over: Record<string, unknown> = {}, nowMs: number = NOW, version = 0) {
  return issueSessionToken(
    {
      address: ADDR,
      chainId: CHAIN_ID,
      nonce: generateNonce(),
      expiresAtMs: nowMs + SESSION_TTL_MS,
      ...over,
    } as { address: string; chainId: number; nonce: string; expiresAtMs: number },
    nowMs,
    version,
  );
}

/** Simulate a token minted before generations existed (no `ver` claim). */
function legacyToken(nowMs: number = NOW): string {
  const secret = process.env.SESSION_SECRET!;
  const claims = {
    v: 1,
    addr: ADDR,
    chainId: CHAIN_ID,
    nonce: generateNonce(),
    iat: nowMs,
    exp: nowMs + 7 * 24 * 3600 * 1000, // the old 7-day lifetime
  };
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function decodeBody(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-secret-for-forever-sessions";
});

describe("forever sessions: issuance", () => {
  it("new tokens carry a far-future expiry (no time-based expiry in practice)", () => {
    const token = issue();
    const body = decodeBody(token);
    expect(body.exp - body.iat).toBe(SESSION_TTL_MS);
    // 10 years, not 7 days.
    expect(SESSION_TTL_MS).toBe(10 * 365 * 24 * 3600 * 1000);
  });

  it("new tokens are stamped with the wallet's current generation", () => {
    const token = issue({}, NOW, 3);
    expect(decodeBody(token).ver).toBe(3);
  });

  it("issueSessionToken rejects a negative version", () => {
    expect(() => issue({}, NOW, -1)).toThrow(/bad version/);
  });
});

describe("forever sessions: verify + logout revocation", () => {
  it("a fresh token verifies when generations match", async () => {
    const store = mockStore();
    const token = issue({}, NOW, 0);
    const r = await verifySessionToken(token, NOW, store);
    expect(r.ok).toBe(true);
  });

  it("logout bumps the generation and kills the old token", async () => {
    const store = mockStore();
    const token = issue({}, NOW, 0);
    expect((await verifySessionToken(token, NOW, store)).ok).toBe(true);

    const generation = await bumpSessionVersion(ADDR, store);
    expect(generation).toBe(1);
    expect(store._map.get(sessionVersionKey(ADDR))).toBe("1");

    const r = await verifySessionToken(token, NOW, store);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/revoked/);
  });

  it("a token minted after logout (current generation) verifies", async () => {
    const store = mockStore();
    await bumpSessionVersion(ADDR, store); // gen 1
    await bumpSessionVersion(ADDR, store); // gen 2
    const version = await getSessionVersion(ADDR, store);
    expect(version).toBe(2);
    // This is exactly what POST /api/auth/login does at issuance.
    const token = issueSessionToken(
      { address: ADDR, chainId: CHAIN_ID, nonce: generateNonce(), expiresAtMs: NOW + SESSION_TTL_MS },
      NOW,
      version,
    );
    const r = await verifySessionToken(token, NOW, store);
    expect(r.ok).toBe(true);
  });

  it("a token with a stale generation is rejected", async () => {
    const store = mockStore();
    await store.set(sessionVersionKey(ADDR), "5");
    const token = issue({}, NOW, 2);
    const r = await verifySessionToken(token, NOW, store);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/revoked/);
  });

  it("fails closed when the store is unreachable", async () => {
    const store = mockStore();
    const token = issue({}, NOW, 0);
    const dead = {
      async get() {
        throw new Error("store down");
      },
    } as unknown as KvStore;
    const r = await verifySessionToken(token, NOW, dead);
    expect(r.ok).toBe(false);
    // And the generation read itself reports -1 (unusable).
    expect(await getSessionVersion(ADDR, dead)).toBe(-1);
  });
});

describe("forever sessions: backward compatibility", () => {
  it("pre-generation tokens (no ver claim) still verify when the wallet never signed out", async () => {
    const store = mockStore();
    const r = await verifySessionToken(legacyToken(), NOW, store);
    expect(r.ok).toBe(true);
  });

  it("pre-generation tokens die after a logout like any other generation-0 token", async () => {
    const store = mockStore();
    const token = legacyToken();
    expect((await verifySessionToken(token, NOW, store)).ok).toBe(true);
    await bumpSessionVersion(ADDR, store);
    const r = await verifySessionToken(token, NOW, store);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/revoked/);
  });

  it("getSessionVersion defaults to 0 for a wallet that never signed out", async () => {
    expect(await getSessionVersion(ADDR, mockStore())).toBe(0);
  });
});

describe("forever sessions: short-lived login challenge", () => {
  function msg(over: Record<string, unknown> = {}) {
    return buildSignInMessage({
      address: ADDR,
      chainId: CHAIN_ID,
      nonce: generateNonce(),
      issuedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + SESSION_TTL_MS).toISOString(),
      uri: ORIGIN,
      ...over,
    });
  }

  it("accepts a fresh sign-in message with a far-future session expiry", () => {
    const r = validateSignInMessage(msg(), { expectedChainId: CHAIN_ID, nowMs: NOW, expectedOrigin: ORIGIN });
    expect(r.ok).toBe(true);
  });

  it("rejects a sign-in message older than the challenge window", () => {
    const stale = msg({ issuedAt: new Date(NOW - 3600_000).toISOString() }); // 1h old, past window+skew
    const r = validateSignInMessage(stale, { expectedChainId: CHAIN_ID, nowMs: NOW, expectedOrigin: ORIGIN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too old/);
  });

  it("still rejects a session lifetime beyond the backstop", () => {
    const tooLong = msg({ expiresAt: new Date(NOW + SESSION_TTL_MS * 2).toISOString() });
    const r = validateSignInMessage(tooLong, { expectedChainId: CHAIN_ID, nowMs: NOW, expectedOrigin: ORIGIN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/lifetime too long/);
  });
});
