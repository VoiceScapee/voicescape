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
  listCapabilityTokens,
  revokeCapabilityToken,
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
    expect(record.expiresAt - record.createdAt).toBe(TOKEN_TTL_MS);

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
