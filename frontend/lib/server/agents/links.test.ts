/**
 * Tests for lib/server/agents/links.ts — agent links, API keys, and key auth.
 *
 * Uses the in-memory KV backend; nothing touches the network except the
 * EVM signature check (pure crypto, no RPC).
 */
import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { createMemoryKvStore } from "../store";
import {
  AGENT_KEY_HEADER,
  AGENT_KEY_RATE_LIMIT,
  claimLinkNonce,
  createAgentLink,
  getLinkByKeyHash,
  issueAgentKey,
  listAgentLinks,
  publicLink,
  resolveAgentKeyAuth,
  revokeAgentLink,
  rotateAgentKey,
  sha256Hex,
  validateLinkMessage,
  verifyLinkSignature,
} from "./links";
import { buildLinkMessage } from "@/lib/agent-link-message";
import { generateNonce } from "@/lib/session-message";

const USER = "0xabcdef0123456789abcdef0123456789abcdef01";
const USER_CANON = USER.toLowerCase();
const AGENT_ACCOUNT = "0.0.7654321";
const ORIGIN = "https://voicescape.vercel.app";

function makeMessage(overrides: Partial<Record<string, string>> = {}) {
  return buildLinkMessage({
    userAddress: USER,
    agentAccountId: AGENT_ACCOUNT,
    uri: ORIGIN,
    nonce: generateNonce(),
    issuedAt: new Date().toISOString(),
    ...overrides,
  });
}

function validOpts(overrides: Record<string, unknown> = {}) {
  return {
    expectedUserAddress: USER_CANON,
    expectedAgentAccountId: AGENT_ACCOUNT,
    expectedOrigin: ORIGIN,
    ...overrides,
  };
}

describe("validateLinkMessage", () => {
  it("accepts a well-formed, fresh message for the right wallet/agent/origin", () => {
    const r = validateLinkMessage(makeMessage(), validOpts());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields.agentAccountId).toBe(AGENT_ACCOUNT);
  });

  it("rejects a wallet mismatch", () => {
    const r = validateLinkMessage(
      makeMessage({ userAddress: "0x0000000000000000000000000000000000000001" }),
      validOpts(),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects an agent account mismatch", () => {
    const r = validateLinkMessage(makeMessage(), validOpts({ expectedAgentAccountId: "0.0.999" }));
    expect(r.ok).toBe(false);
  });

  it("rejects an origin mismatch (cross-site replay)", () => {
    const r = validateLinkMessage(makeMessage(), validOpts({ expectedOrigin: "https://evil.example" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/different site/);
  });

  it("skips the origin check when the origin is not configured", () => {
    const r = validateLinkMessage(makeMessage(), validOpts({ expectedOrigin: null }));
    expect(r.ok).toBe(true);
  });

  it("rejects expired and future messages", () => {
    const old = makeMessage({ issuedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    const expired = validateLinkMessage(old, validOpts());
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error).toMatch(/expired/);

    const future = makeMessage({ issuedAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    expect(validateLinkMessage(future, validOpts()).ok).toBe(false);
  });
});

describe("verifyLinkSignature", () => {
  it("accepts a real EVM personal_sign from the wallet", async () => {
    const wallet = ethers.Wallet.createRandom();
    const msg = makeMessage({ userAddress: wallet.address });
    const sig = await wallet.signMessage(msg);
    expect(await verifyLinkSignature(msg, sig, wallet.address)).toBe(true);
  });

  it("rejects a signature from a different wallet", async () => {
    const a = ethers.Wallet.createRandom();
    const b = ethers.Wallet.createRandom();
    const msg = makeMessage({ userAddress: a.address });
    const sig = await b.signMessage(msg);
    expect(await verifyLinkSignature(msg, sig, a.address)).toBe(false);
  });

  it("rejects garbage signatures", async () => {
    const msg = makeMessage();
    expect(await verifyLinkSignature(msg, "0xdeadbeef", USER_CANON)).toBe(false);
  });
});

describe("issueAgentKey", () => {
  it("issues prefixed keys with hash-only storage material", () => {
    const a = issueAgentKey();
    const b = issueAgentKey();
    expect(a.key).toMatch(/^vsak_[0-9a-f]{48}$/);
    expect(a.keyHash).toBe(sha256Hex(a.key));
    expect(a.keyId).toBe(a.keyHash.slice(0, 12));
    expect(a.key).not.toBe(b.key);
    // The hash reveals nothing of the key.
    expect(a.keyHash).not.toContain("vsak_");
  });
});

describe("agent links lifecycle", () => {
  it("creates a link, issues the key once, and stores only the hash", async () => {
    const store = createMemoryKvStore();
    const created = await createAgentLink(store, {
      userAddress: USER_CANON,
      userAddressDisplay: USER,
      agentAccountId: AGENT_ACCOUNT,
      username: "test-agent",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.apiKey).toMatch(/^vsak_/);
    expect(created.link.agentAccountId).toBe(AGENT_ACCOUNT);

    // The key lookup entry holds the hash, never the plaintext.
    const raw = await store.get(`agent-key:${sha256Hex(created.apiKey)}`);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(created.apiKey);
    expect(JSON.parse(raw!).keyHash).toBe(sha256Hex(created.apiKey));

    // Listing shows links without any key material.
    const links = await listAgentLinks(store, USER_CANON);
    expect(links).toHaveLength(1);
    expect(links[0].keyHint).toMatch(/^vsak_••••[0-9a-f]{4}$/);
    expect(JSON.stringify(links[0])).not.toContain("keyHash");
  });

  it("refuses a duplicate active link", async () => {
    const store = createMemoryKvStore();
    const input = {
      userAddress: USER_CANON,
      userAddressDisplay: USER,
      agentAccountId: AGENT_ACCOUNT,
      username: "test-agent",
    };
    expect((await createAgentLink(store, input)).ok).toBe(true);
    const dup = await createAgentLink(store, input);
    expect(dup.ok).toBe(false);
  });

  it("resolves key auth and binds agentId at the route layer", async () => {
    const store = createMemoryKvStore();
    const created = await createAgentLink(store, {
      userAddress: USER_CANON,
      userAddressDisplay: USER,
      agentAccountId: AGENT_ACCOUNT,
      username: "test-agent",
    });
    if (!created.ok) throw new Error("setup failed");
    const headers = new Headers({ [AGENT_KEY_HEADER]: created.apiKey });
    const auth = await resolveAgentKeyAuth(headers, store);
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(auth.identity.agentAccountId).toBe(AGENT_ACCOUNT);
    expect(auth.identity.username).toBe("test-agent");
  });

  it("rejects missing, malformed, and unknown keys", async () => {
    const store = createMemoryKvStore();
    const missing = await resolveAgentKeyAuth(new Headers(), store);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(401);
    const malformed = await resolveAgentKeyAuth(new Headers({ [AGENT_KEY_HEADER]: "not-a-key" }), store);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.status).toBe(401);
    const unknown = await resolveAgentKeyAuth(new Headers({ [AGENT_KEY_HEADER]: "vsak_" + "ab".repeat(24) }), store);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.status).toBe(401);
  });

  it("enforces the per-key quota, then lets the key work again conceptually", async () => {
    const store = createMemoryKvStore();
    const created = await createAgentLink(store, {
      userAddress: USER_CANON,
      userAddressDisplay: USER,
      agentAccountId: AGENT_ACCOUNT,
      username: "test-agent",
    });
    if (!created.ok) throw new Error("setup failed");
    const headers = new Headers({ [AGENT_KEY_HEADER]: created.apiKey });
    for (let i = 0; i < AGENT_KEY_RATE_LIMIT; i++) {
      const r = await resolveAgentKeyAuth(headers, store);
      expect(r.ok).toBe(true);
    }
    const limited = await resolveAgentKeyAuth(headers, store);
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.status).toBe(429);
  });

  it("revocation kills the key immediately", async () => {
    const store = createMemoryKvStore();
    const created = await createAgentLink(store, {
      userAddress: USER_CANON,
      userAddressDisplay: USER,
      agentAccountId: AGENT_ACCOUNT,
      username: "test-agent",
    });
    if (!created.ok) throw new Error("setup failed");
    const headers = new Headers({ [AGENT_KEY_HEADER]: created.apiKey });
    expect((await resolveAgentKeyAuth(headers, store)).ok).toBe(true);
    expect(await revokeAgentLink(store, USER_CANON, AGENT_ACCOUNT)).toBe(true);
    const after = await resolveAgentKeyAuth(headers, store);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error).toMatch(/revoked/);
    expect(await revokeAgentLink(store, USER_CANON, AGENT_ACCOUNT)).toBe(false);
  });

  it("rotation invalidates the old key and issues a new one", async () => {
    const store = createMemoryKvStore();
    const created = await createAgentLink(store, {
      userAddress: USER_CANON,
      userAddressDisplay: USER,
      agentAccountId: AGENT_ACCOUNT,
      username: "test-agent",
    });
    if (!created.ok) throw new Error("setup failed");
    const rotated = await rotateAgentKey(store, USER_CANON, AGENT_ACCOUNT);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.apiKey).not.toBe(created.apiKey);

    const oldHeaders = new Headers({ [AGENT_KEY_HEADER]: created.apiKey });
    const oldAuth = await resolveAgentKeyAuth(oldHeaders, store);
    expect(oldAuth.ok).toBe(false);
    if (!oldAuth.ok) expect(oldAuth.status).toBe(401);
    const newHeaders = new Headers({ [AGENT_KEY_HEADER]: rotated.apiKey });
    const auth = await resolveAgentKeyAuth(newHeaders, store);
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.identity.username).toBe("test-agent");
  });

  it("rotation refuses when there is no active link", async () => {
    const store = createMemoryKvStore();
    expect((await rotateAgentKey(store, USER_CANON, AGENT_ACCOUNT)).ok).toBe(false);
  });
});

describe("claimLinkNonce", () => {
  it("a nonce can be claimed exactly once", async () => {
    const store = createMemoryKvStore();
    const nonce = generateNonce();
    expect(await claimLinkNonce(store, nonce)).toBe(true);
    expect(await claimLinkNonce(store, nonce)).toBe(false);
  });
});

describe("publicLink", () => {
  it("never exposes the key hash", async () => {
    const store = createMemoryKvStore();
    const created = await createAgentLink(store, {
      userAddress: USER_CANON,
      userAddressDisplay: USER,
      agentAccountId: AGENT_ACCOUNT,
      username: "test-agent",
    });
    if (!created.ok) throw new Error("setup failed");
    const record = await getLinkByKeyHash(store, sha256Hex(created.apiKey));
    expect(record).not.toBeNull();
    const pub = publicLink(record!);
    expect(JSON.stringify(pub)).not.toContain("keyHash");
    expect(pub.keyHint.endsWith(record!.keyHash.slice(-4))).toBe(true);
  });
});
