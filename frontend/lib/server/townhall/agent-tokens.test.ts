/**
 * Scoped agent-token tests: issuance, verification, expiry, tampering,
 * revocation, chain binding, and the fail-closed port default. No network —
 * the revocation-version KV uses the in-memory store.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getKvStore } from "../store";
import {
  AGENT_TOKEN_TTL_MS,
  AGENT_TOKEN_VERSION_TTL_MS,
  agentTokenVersionKey,
  issueAgentToken,
  peekTokenVersion,
  testAuthPort,
  verifyAgentToken,
  verifySessionToken,
  issueSessionToken,
} from "./auth";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const CHAIN_ID = 296;
const ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const AGENT = "thechomps";

function memStore() {
  const m = new Map<string, string>();
  return {
    async get(k: string) {
      return m.has(k) ? m.get(k)! : null;
    },
    async set(k: string, v: string) {
      m.set(k, v);
    },
  };
}

function issue(over: Record<string, unknown> = {}, nowMs: number = NOW) {
  return issueAgentToken(
    {
      address: ADDR,
      agentUsername: AGENT,
      chainId: CHAIN_ID,
      expiresAtMs: nowMs + AGENT_TOKEN_TTL_MS,
      version: 1,
      ...over,
    },
    nowMs,
  );
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-only-agent-token-secret-0123456789";
});

describe("issueAgentToken", () => {
  it("mints a v2 token with scope=agent", () => {
    const tok = issue();
    expect(peekTokenVersion(tok)).toBe(2);
    const body = JSON.parse(Buffer.from(tok.split(".")[0], "base64url").toString("utf8"));
    expect(body).toMatchObject({ v: 2, addr: ADDR, agent: AGENT, scope: "agent", ver: 1, chainId: CHAIN_ID });
  });

  it("rejects bad inputs", () => {
    expect(() => issue({ address: "0xbad" })).toThrow(/bad address/);
    // Uppercase normalizes to lowercase rather than throwing.
    expect(issue({ agentUsername: "UPPER" }).split(".").length).toBe(2);
    expect(() => issue({ agentUsername: "ab" })).toThrow(/bad agent username/);
    expect(() => issue({ agentUsername: "has space" })).toThrow(/bad agent username/);
    expect(() => issue({ version: 0 })).toThrow(/bad version/);
    expect(() => issue({ expiresAtMs: NOW - 1 })).toThrow(/bad expiry/);
    expect(() => issue({ expiresAtMs: NOW + AGENT_TOKEN_TTL_MS + 600_000 })).toThrow(/exceeds 7 days/);
  });
});

describe("verifyAgentToken", () => {
  it("accepts a well-formed token when the KV version matches", async () => {
    const store = memStore();
    await store.set(agentTokenVersionKey(ADDR, AGENT), "1");
    const r = await verifyAgentToken(issue(), { store, nowMs: NOW, chainId: CHAIN_ID });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.address).toBe(ADDR);
      expect(r.session.agent).toEqual({ username: AGENT });
    }
  });

  it("rejects a tampered signature", async () => {
    const store = memStore();
    await store.set(agentTokenVersionKey(ADDR, AGENT), "1");
    const tok = issue();
    const bad = tok.slice(0, -2) + "xx";
    const r = await verifyAgentToken(bad, { store, nowMs: NOW, chainId: CHAIN_ID });
    expect(r.ok).toBe(false);
  });

  it("rejects when the KV version differs (revoked)", async () => {
    const store = memStore();
    await store.set(agentTokenVersionKey(ADDR, AGENT), "2"); // bumped after mint
    const r = await verifyAgentToken(issue(), { store, nowMs: NOW, chainId: CHAIN_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/revoked/i);
  });

  it("rejects when no version key exists (fail closed)", async () => {
    const r = await verifyAgentToken(issue(), { store: memStore(), nowMs: NOW, chainId: CHAIN_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/revoked/i);
  });

  it("rejects expired tokens", async () => {
    const store = memStore();
    await store.set(agentTokenVersionKey(ADDR, AGENT), "1");
    const tok = issueAgentToken(
      { address: ADDR, agentUsername: AGENT, chainId: CHAIN_ID, expiresAtMs: NOW - 1000, version: 1 },
      NOW - 2000,
    );
    const r = await verifyAgentToken(tok, { store, nowMs: NOW, chainId: CHAIN_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/expired/i);
  });

  it("rejects a wrong chain", async () => {
    const store = memStore();
    await store.set(agentTokenVersionKey(ADDR, AGENT), "1");
    const r = await verifyAgentToken(issue(), { store, nowMs: NOW, chainId: 999 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/wrong chain/i);
  });

  it("rejects a forged scope value", async () => {
    // Take a valid token body, flip scope to "admin", re-sign is impossible
    // without the secret — instead assert the verifier checks scope by
    // feeding a token whose body claims a different scope but valid HMAC.
    // We can produce one only because we hold the test secret here.
    const { createHmac } = await import("crypto");
    const body = Buffer.from(
      JSON.stringify({
        v: 2, addr: ADDR, agent: AGENT, scope: "admin", ver: 1,
        chainId: CHAIN_ID, iat: NOW, exp: NOW + AGENT_TOKEN_TTL_MS,
      }),
    ).toString("base64url");
    const sig = createHmac("sha256", process.env.SESSION_SECRET!).update(body).digest("base64url");
    const store = memStore();
    await store.set(agentTokenVersionKey(ADDR, AGENT), "1");
    const r = await verifyAgentToken(`${body}.${sig}`, { store, nowMs: NOW, chainId: CHAIN_ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/malformed/i);
  });

  it("fails closed when the store is unreachable", async () => {
    const store = { get: async () => { throw new Error("boom"); } };
    const r = await verifyAgentToken(issue(), { store, nowMs: NOW, chainId: CHAIN_ID });
    expect(r.ok).toBe(false);
  });
});

describe("port wiring (fail-closed default)", () => {
  const mkPort = (now: number) => testAuthPort({ chainId: () => CHAIN_ID, nowMs: () => now });

  it("rejects agent tokens unless allowAgent is passed", async () => {
    const kv = getKvStore();
    await kv.set(agentTokenVersionKey(ADDR, AGENT), "1", AGENT_TOKEN_VERSION_TTL_MS);
    const tok = issueAgentToken(
      { address: ADDR, agentUsername: AGENT, chainId: CHAIN_ID, expiresAtMs: NOW + 3600_000, version: 1 },
      NOW,
    );
    const port = mkPort(NOW);
    const denied = await port.verifySession(tok);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toMatch(/not accepted/i);
    const allowed = await port.verifySession(tok, { allowAgent: true });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.session.agent).toEqual({ username: AGENT });
    await kv.del(agentTokenVersionKey(ADDR, AGENT));
  });

  it("v1 session tokens are unaffected by the agent path", async () => {
    const tok = issueSessionToken(
      { address: ADDR, chainId: CHAIN_ID, nonce: "a".repeat(32), expiresAtMs: NOW + 3600_000 },
      NOW,
    );
    const r = await mkPort(NOW).verifySession(tok);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.session.agent).toBeUndefined();
  });

  it("peekTokenVersion routes garbage to the v1 path", () => {
    expect(peekTokenVersion("garbage")).toBe(0);
    expect(peekTokenVersion("a.b")).toBe(0);
  });
});
