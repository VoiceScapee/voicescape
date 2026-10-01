/**
 * Tests for the claim-packages store (lib/server/claim-packages.ts).
 * Fake in-memory KvStore — no network, no real store.
 */
import { describe, it, expect } from "vitest";
import type { KvStore } from "./store";
import {
  stashClaimPackage,
  getClaimPackage,
  saveClaimPackage,
  deleteClaimPackage,
} from "./claim-packages";

function fakeStore() {
  const map = new Map<string, { value: string; ttlMs: number }>();
  const store: KvStore = {
    async get(k: string) { return map.get(k)?.value ?? null; },
    async set(k: string, v: string, ttlMs: number) { map.set(k, { value: v, ttlMs }); },
    async del(k: string) { map.delete(k); },
    async incr() { return 1; },
    async setNx(k: string, v: string, ttlMs: number) {
      if (map.has(k)) return false;
      map.set(k, { value: v, ttlMs });
      return true;
    },
    async clearPrefix(prefix: string) {
      for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
    },
  };
  return { store, map };
}

const INPUT = {
  username: "thechomps",
  purpose: "Hermes's official Voicescape agent page",
  displayName: "Hermes",
  capabilities: ["chat", "code"],
  operator: null,
  claimCode: "3RSF-6GTX",
  ownerAccountId: "0.0.10425049",
  pageUrl: "https://voicescape.vercel.app/thechomps",
};

describe("claim-packages", () => {
  it("stashes a package under a 128-bit random id with a 24h TTL", async () => {
    const { store, map } = fakeStore();
    const rec = await stashClaimPackage(INPUT, store);
    expect(rec.id).toMatch(/^[0-9a-f]{32}$/);
    const key = `claim-package:${rec.id}`;
    expect(map.get(key)?.ttlMs).toBe(24 * 3_600_000);
    expect(rec.username).toBe("thechomps");
    expect(rec.claimCode).toBe("3RSF-6GTX");
    // Nothing pinned or built at prepare time.
    expect(rec.cid).toBeNull();
  });

  it("reads the package back by id", async () => {
    const { store } = fakeStore();
    const rec = await stashClaimPackage(INPUT, store);
    const back = await getClaimPackage(rec.id, store);
    expect(back?.username).toBe("thechomps");
    expect(back?.purpose).toBe(INPUT.purpose);
    expect(back?.ownerAccountId).toBe("0.0.10425049");
  });

  it("returns null for unknown ids", async () => {
    const { store } = fakeStore();
    expect(await getClaimPackage("f".repeat(32), store)).toBeNull();
  });

  it("returns null for malformed ids instead of hitting the store", async () => {
    const { store, map } = fakeStore();
    expect(await getClaimPackage("not-a-package-id", store)).toBeNull();
    expect(map.size).toBe(0);
  });

  it("saveClaimPackage updates the record (finalize pins the cid)", async () => {
    const { store } = fakeStore();
    const rec = await stashClaimPackage(INPUT, store);
    rec.cid = "QmTestCid";
    await saveClaimPackage(rec, store);
    expect((await getClaimPackage(rec.id, store))?.cid).toBe("QmTestCid");
  });

  it("deleteClaimPackage removes the record", async () => {
    const { store } = fakeStore();
    const rec = await stashClaimPackage(INPUT, store);
    await deleteClaimPackage(rec.id, store);
    expect(await getClaimPackage(rec.id, store)).toBeNull();
  });

  it("accepts a minimal input without overrides", async () => {
    const { store } = fakeStore();
    const rec = await stashClaimPackage(
      { username: "someagent", purpose: "testing", pageUrl: "https://voicescape.vercel.app/someagent" },
      store,
    );
    expect(rec.ownerAccountId).toBeNull();
    expect(rec.operator).toBeNull();
    expect(rec.claimCode).toBeNull();
  });

  it("rejects invalid input instead of stashing garbage", async () => {
    const { store } = fakeStore();
    await expect(stashClaimPackage({ ...INPUT, username: "AB" }, store)).rejects.toThrow();
    await expect(stashClaimPackage({ ...INPUT, username: "has space" }, store)).rejects.toThrow();
    await expect(stashClaimPackage({ ...INPUT, purpose: "x".repeat(501) }, store)).rejects.toThrow();
    await expect(stashClaimPackage({ ...INPUT, purpose: "" }, store)).rejects.toThrow();
    await expect(stashClaimPackage({ ...INPUT, ownerAccountId: "nope" }, store)).rejects.toThrow();
    await expect(stashClaimPackage({ ...INPUT, operator: "nope" }, store)).rejects.toThrow();
    await expect(stashClaimPackage({ ...INPUT, claimCode: "BAD CODE!" }, store)).rejects.toThrow();
  });
});
