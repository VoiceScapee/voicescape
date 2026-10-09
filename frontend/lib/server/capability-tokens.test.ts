/**
 * Tests for the capability-token system (lib/server/capability-tokens.ts).
 * All persistence is a fake in-memory KvStore — no network, no real store.
 * The raw token is only ever asserted at issuance; afterwards only hashes
 * exist in the store.
 */
import { describe, it, expect } from "vitest";
import type { KvStore } from "./store";
import {
  issueCapabilityToken,
  validateCapabilityToken,
  validateCapabilityTokenLive,
  listCapabilityTokens,
  revokeCapabilityToken,
  appendTokenAudit,
  readTokenAudit,
  consumeScopeBudget,
  remainingScopeBudget,
  stageDraft,
  readDraft,
  TOKEN_TTL_MS,
} from "./capability-tokens";

function fakeStore(): KvStore {
  const map = new Map<string, string>();
  return {
    async get(k: string) { return map.get(k) ?? null; },
    async set(k: string, v: string) { map.set(k, v); },
    async del(k: string) { map.delete(k); },
    async incr() { return 1; },
    async setNx(k: string, v: string) { if (map.has(k)) return false; map.set(k, v); return true; },
    async clearPrefix(prefix: string) { for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k); },
    __map: map,
  } as unknown as KvStore;
}

const OWNER = "0.0.10424063";

describe("capability-tokens", () => {
  it("issues a token and validates it for a granted scope", async () => {
    const store = fakeStore();
    const { token, record } = await issueCapabilityToken(
      OWNER,
      { label: "test token", scopes: ["page:update:propose"] },
      store,
    );
    expect(token.startsWith("vs_cap_")).toBe(true);
    expect(record.ownerAccountId).toBe(OWNER);
    expect(record.revokedAt).toBeNull();
    expect(record.version).toBe(1);
    expect(record.expiresAt).not.toBeNull();
    expect(record.expiresAt! - record.createdAt).toBe(TOKEN_TTL_MS);

    const v = await validateCapabilityToken(token, "page:update:propose", store);
    expect(v).not.toBeNull();
    expect(v!.record.id).toBe(record.id);
  });

  it("never stores the raw token — only its hash", async () => {
    const store = fakeStore();
    const { token } = await issueCapabilityToken(OWNER, { label: "x" }, store);
    const map = (store as unknown as { __map: Map<string, string> }).__map;
    const dump = [...map.values()].join("\n");
    expect(dump.includes(token)).toBe(false);
  });

  it("fails closed on garbage, wrong prefix, and unknown tokens", async () => {
    const store = fakeStore();
    expect(await validateCapabilityToken("garbage", "page:read", store)).toBeNull();
    expect(await validateCapabilityToken(null, "page:read", store)).toBeNull();
    expect(await validateCapabilityToken("vs_cap_" + "0".repeat(48), "page:read", store)).toBeNull();
    expect(await validateCapabilityToken("vs_cap_short", "page:read", store)).toBeNull();
  });

  it("enforces scopes: a token without the scope is rejected", async () => {
    const store = fakeStore();
    const { token } = await issueCapabilityToken(
      OWNER,
      { label: "read-only", scopes: ["page:read"] },
      store,
    );
    expect(await validateCapabilityToken(token, "page:read", store)).not.toBeNull();
    expect(await validateCapabilityToken(token, "page:update:propose", store)).toBeNull();
    expect(await validateCapabilityToken(token, "media:pin", store)).toBeNull();
  });

  it("revocation is instant — the next validation fails", async () => {
    const store = fakeStore();
    const { token, record } = await issueCapabilityToken(OWNER, { label: "doomed" }, store);
    expect(await validateCapabilityToken(token, "page:read", store)).not.toBeNull();
    expect(await revokeCapabilityToken(OWNER, record.id, store)).toBe(true);
    expect(await validateCapabilityToken(token, "page:read", store)).toBeNull();
    // Second revoke is a no-op.
    expect(await revokeCapabilityToken(OWNER, record.id, store)).toBe(false);
  });

  it("a token cannot be revoked by a different owner", async () => {
    const store = fakeStore();
    const { record } = await issueCapabilityToken(OWNER, { label: "mine" }, store);
    expect(await revokeCapabilityToken("0.0.99999", record.id, store)).toBe(false);
  });

  it("lists live tokens without raw secrets, newest first", async () => {
    const store = fakeStore();
    const a = await issueCapabilityToken(OWNER, { label: "first" }, store);
    const b = await issueCapabilityToken(OWNER, { label: "second" }, store);
    await revokeCapabilityToken(OWNER, a.record.id, store);
    const list = await listCapabilityTokens(OWNER, store);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(b.record.id);
    expect(JSON.stringify(list).includes(b.token)).toBe(false);
  });

  it("rejects bad owners, empty labels, and unknown scopes at issuance", async () => {
    const store = fakeStore();
    await expect(issueCapabilityToken("nope", { label: "x" }, store)).rejects.toThrow();
    await expect(issueCapabilityToken(OWNER, { label: "  " }, store)).rejects.toThrow();
    await expect(
      issueCapabilityToken(OWNER, { label: "x", scopes: ["funds:move"] as never }, store),
    ).rejects.toThrow();
    await expect(
      issueCapabilityToken(OWNER, { label: "x", scopes: [] }, store),
    ).rejects.toThrow();
  });
});

describe("capability-tokens v2 — execution scopes", () => {
  it("issues a v2 token with new scopes and no expiry by default", async () => {
    const store = fakeStore();
    const { token, record } = await issueCapabilityToken(
      OWNER,
      {
        label: "v2",
        scopes: ["availability:write", "draft:stage"],
        version: 2,
      },
      store,
    );
    expect(record.version).toBe(2);
    expect(record.expiresAt).toBeNull();
    expect(record.scopes).toEqual(["availability:write", "draft:stage"]);
    // v1 default preserved
    const v1 = await issueCapabilityToken(OWNER, { label: "v1" }, store);
    expect(v1.record.version).toBe(1);
    expect(v1.record.expiresAt).not.toBeNull();

    const v = await validateCapabilityToken(token, "availability:write", store);
    expect(v).not.toBeNull();
    // v1 token does not carry the new scope
    expect(await validateCapabilityToken(v1.token, "availability:write", store)).toBeNull();
  });

  it("rejects unknown v2 scopes and bad agent accounts at issuance", async () => {
    const store = fakeStore();
    await expect(
      issueCapabilityToken(OWNER, { label: "x", scopes: ["chat:nuke"] as never }, store),
    ).rejects.toThrow();
    await expect(
      issueCapabilityToken(OWNER, { label: "x", version: 2, agentAccountId: "nope" }, store),
    ).rejects.toThrow();
  });

  it("audit log records issuance and actions, newest last, capped", async () => {
    const store = fakeStore();
    const { record } = await issueCapabilityToken(OWNER, { label: "audit", version: 2 }, store);
    await appendTokenAudit(record.id, { ts: 1, action: "test:one", detail: "first" }, store);
    await appendTokenAudit(record.id, { ts: 2, action: "test:two", detail: "second" }, store);
    const log = await readTokenAudit(record.id, store);
    expect(log.length).toBe(3); // issued + two
    expect(log[0].action).toBe("issued");
    expect(log[2].action).toBe("test:two");
    // raw token never in the audit
    expect(JSON.stringify(log)).not.toContain("vs_cap_");
  });

  it("rate limits are per-scope per-day and fail closed", async () => {
    const store = fakeStore();
    const { record } = await issueCapabilityToken(
      OWNER,
      { label: "rl", scopes: ["availability:write"], version: 2 },
      store,
    );
    // 10/day for availability:write
    let remaining: number | null = null;
    for (let i = 0; i < 10; i++) {
      remaining = await consumeScopeBudget(record.tokenHash, "availability:write", store);
    }
    expect(remaining).toBe(0);
    expect(await consumeScopeBudget(record.tokenHash, "availability:write", store)).toBe(0);
    // unlimited scopes return null
    expect(await consumeScopeBudget(record.tokenHash, "page:read", store)).toBeNull();
    expect(await remainingScopeBudget(record.tokenHash, "page:read", store)).toBeNull();
    // other tokens unaffected
    const other = await issueCapabilityToken(OWNER, { label: "rl2", scopes: ["availability:write"], version: 2 }, store);
    expect(await remainingScopeBudget(other.record.tokenHash, "availability:write", store)).toBe(10);
  });

  it("draft staging round-trips, latest wins", async () => {
    const store = fakeStore();
    const { record } = await issueCapabilityToken(OWNER, { label: "d", version: 2 }, store);
    await stageDraft("my-agent", record.id, "v1 summary", "content one", store);
    await stageDraft("my-agent", record.id, "v2 summary", "content two", store);
    const d = await readDraft("my-agent", store);
    expect(d?.content).toBe("content two");
    expect(d?.changeSummary).toBe("v2 summary");
    expect(await readDraft("nobody", store)).toBeNull();
  });

  it("revocation audit entry is written and validation fails after", async () => {
    const store = fakeStore();
    const { token, record } = await issueCapabilityToken(
      OWNER,
      { label: "rev", scopes: ["availability:write"], version: 2 },
      store,
    );
    expect(await revokeCapabilityToken(OWNER, record.id, store)).toBe(true);
    expect(await validateCapabilityToken(token, "availability:write", store)).toBeNull();
    expect(await validateCapabilityTokenLive(token, store)).toBeNull();
    const log = await readTokenAudit(record.id, store);
    expect(log[log.length - 1].action).toBe("revoked");
  });

  it("validateCapabilityTokenLive works without a scope, still fail-closed", async () => {
    const store = fakeStore();
    const { token } = await issueCapabilityToken(OWNER, { label: "live", version: 2 }, store);
    expect(await validateCapabilityTokenLive(token, store)).not.toBeNull();
    expect(await validateCapabilityTokenLive("vs_cap_" + "0".repeat(48), store)).toBeNull();
    expect(await validateCapabilityTokenLive("garbage", store)).toBeNull();
  });
});
