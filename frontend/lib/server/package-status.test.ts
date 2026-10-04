/**
 * Tests for the package-status store (lib/server/package-status.ts).
 * Fake in-memory KvStore — no network, no real store.
 */
import { describe, it, expect } from "vitest";
import type { KvStore } from "./store";
import { setPackageStatus, getPackageStatus } from "./package-status";

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

const ID = "a".repeat(32);

describe("package-status", () => {
  it("normalizes legacy 'finalized' records to 'awaiting_signature' on read", async () => {
    const { store, map } = fakeStore();
    // Simulate a record written before the rename: raw JSON with the old status.
    map.set(`package-status:claim:${ID}`, {
      value: JSON.stringify({
        packageId: ID,
        kind: "claim",
        status: "finalized",
        updatedAt: Date.now(),
        username: "thechomps",
      }),
      ttlMs: 7 * 24 * 3_600_000,
    });
    const rec = await getPackageStatus("claim", ID, store);
    expect(rec?.status).toBe("awaiting_signature");
    expect(rec?.username).toBe("thechomps");
  });

  it("round-trips a status record with a 7-day TTL", async () => {
    const { store, map } = fakeStore();
    await setPackageStatus("claim", ID, "awaiting_signature", {
      username: "thechomps",
      transactionId: "0.0.1@2.3",
      detail: "unsigned tx issued",
    }, store);
    const rec = await getPackageStatus("claim", ID, store);
    expect(rec?.status).toBe("awaiting_signature");
    expect(rec?.username).toBe("thechomps");
    expect(rec?.transactionId).toBe("0.0.1@2.3");
    expect(rec?.kind).toBe("claim");
    expect(map.get(`package-status:claim:${ID}`)?.ttlMs).toBe(7 * 24 * 3_600_000);
  });

  it("keeps claim and vault namespaces separate", async () => {
    const { store } = fakeStore();
    await setPackageStatus("claim", ID, "race_lost", {}, store);
    await setPackageStatus("vault", ID, "completed", {}, store);
    expect((await getPackageStatus("claim", ID, store))?.status).toBe("race_lost");
    expect((await getPackageStatus("vault", ID, store))?.status).toBe("completed");
  });

  it("returns null for unknown or malformed ids, never throws", async () => {
    const { store } = fakeStore();
    expect(await getPackageStatus("claim", "b".repeat(32), store)).toBeNull();
    expect(await getPackageStatus("claim", "not-an-id", store)).toBeNull();
    await setPackageStatus("claim", "not-an-id", "awaiting_signature", {}, store); // no-op
    await setPackageStatus("claim", ID, "awaiting_signature", {}, {
      ...store,
      set: async () => { throw new Error("kv down"); },
    }); // never throws
  });

  it("overwrites with the latest terminal state", async () => {
    const { store } = fakeStore();
    await setPackageStatus("claim", ID, "awaiting_signature", {}, store);
    await setPackageStatus("claim", ID, "completed", { detail: "intro linked" }, store);
    const rec = await getPackageStatus("claim", ID, store);
    expect(rec?.status).toBe("completed");
    expect(rec?.detail).toBe("intro linked");
  });
});
