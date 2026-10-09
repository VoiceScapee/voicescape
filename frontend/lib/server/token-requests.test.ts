/**
 * Tests for link-based token issuance requests (lib/server/token-requests.ts).
 * All persistence is a fake in-memory KvStore — no network, no real store.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { KvStore } from "./store";
import {
  createTokenRequest,
  getTokenRequest,
  consumeTokenRequest,
} from "./token-requests";

function fakeStore(): KvStore {
  const map = new Map<string, string>();
  return {
    async get(k: string) { return map.get(k) ?? null; },
    async set(k: string, v: string) { map.set(k, v); },
    async del(k: string) { map.delete(k); },
    async incr() { return 1; },
    async setNx(k: string, v: string) { if (map.has(k)) return false; map.set(k, v); return true; },
    async clearPrefix(prefix: string) { for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k); },
  };
}

describe("token-requests issuance links", () => {
  let store: KvStore;
  beforeEach(() => { store = fakeStore(); });

  it("creates a request with an unguessable id and default scopes", async () => {
    const rec = await createTokenRequest({ label: "muse AI agent" }, store);
    expect(rec.id).toMatch(/^[0-9a-f]{32}$/);
    expect(rec.label).toBe("muse AI agent");
    // Safe default: the original three propose scopes. Execution scopes
    // (message:send, availability:write, draft:stage) and the spending scopes
    // (purchase:propose, review:propose) must always be explicitly requested.
    expect(rec.scopes).toEqual([
      "page:update:propose",
      "page:read",
      "media:pin",
    ]);
    expect(rec.createdAt).toBeGreaterThan(0);
  });

  it("honors a requested scope subset", async () => {
    const rec = await createTokenRequest({ label: "x", scopes: ["page:update:propose"] }, store);
    expect(rec.scopes).toEqual(["page:update:propose"]);
  });

  it("rejects a missing label and bad scopes", async () => {
    await expect(createTokenRequest({ label: "   " }, store)).rejects.toThrow(/label/);
    await expect(
      createTokenRequest({ label: "x", scopes: ["admin:everything"] as never }, store),
    ).rejects.toThrow(/scopes/);
    await expect(createTokenRequest({ label: "x", scopes: [] }, store)).rejects.toThrow(/scopes/);
  });

  it("reads a request back by id", async () => {
    const rec = await createTokenRequest({ label: "tester" }, store);
    const found = await getTokenRequest(rec.id, store);
    expect(found).not.toBeNull();
    expect(found!.label).toBe("tester");
  });

  it("returns null for malformed or unknown ids", async () => {
    expect(await getTokenRequest("nope", store)).toBeNull();
    expect(await getTokenRequest("a".repeat(32), store)).toBeNull();
    expect(await getTokenRequest("", store)).toBeNull();
  });

  it("consume is one-time — the link cannot be reused", async () => {
    const rec = await createTokenRequest({ label: "one-shot" }, store);
    const first = await consumeTokenRequest(rec.id, store);
    expect(first).not.toBeNull();
    expect(first!.label).toBe("one-shot");
    expect(await consumeTokenRequest(rec.id, store)).toBeNull();
    expect(await getTokenRequest(rec.id, store)).toBeNull();
  });
});
