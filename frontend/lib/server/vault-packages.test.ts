/**
 * Tests for vault-packages: stash/get/delete, validation, 3-per-day
 * rate limit. Uses an in-memory KvStore — no Upstash, no network.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  stashVaultPackage,
  getVaultPackage,
  deleteVaultPackage,
  VAULT_PACKAGE_DAILY_LIMIT,
} from "./vault-packages";
import type { KvStore } from "./store";

function memStore(): KvStore {
  const m = new Map<string, { value: string; count: number; expiresAt: number }>();
  const live = (k: string) => {
    const e = m.get(k);
    if (!e || e.expiresAt < Date.now()) {
      m.delete(k);
      return null;
    }
    return e;
  };
  return {
    async incr(k, ttlMs) {
      let e = live(k);
      if (!e) {
        e = { value: "0", count: 0, expiresAt: Date.now() + ttlMs };
        m.set(k, e);
      }
      e.count += 1;
      e.value = String(e.count);
      return e.count;
    },
    async setNx(k, v, ttlMs) {
      if (live(k)) return false;
      m.set(k, { value: v, count: 0, expiresAt: Date.now() + ttlMs });
      return true;
    },
    async set(k, v, ttlMs) {
      m.set(k, { value: v, count: 0, expiresAt: Date.now() + ttlMs });
    },
    async get(k) {
      return live(k)?.value ?? null;
    },
    async del(k) {
      m.delete(k);
    },
    async clearPrefix(prefix) {
      for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
    },
  };
}

const A = "a".repeat(64);

function input(over: Record<string, unknown> = {}) {
  return {
    agentUsername: "thechomps",
    agentIntroText: "Hello, I am Kimberly.",
    agentPublicKey: A,
    budgetHbar: 5,
    ...over,
  };
}

let store: KvStore;
beforeEach(() => {
  store = memStore();
});

describe("stash + get + delete (single use)", () => {
  it("round-trips a package; delete makes it single-use (no replay)", async () => {
    const rec = await stashVaultPackage(input(), store);
    expect(rec.id).toMatch(/^[0-9a-f]{32}$/);
    expect(rec.createdAt).toBeGreaterThan(0);

    const got = await getVaultPackage(rec.id, store);
    expect(got?.agentUsername).toBe("thechomps");
    expect(got?.agentPublicKey).toBe(A);
    expect(got?.budgetHbar).toBe(5);

    // Finalize deletes — no replay.
    await deleteVaultPackage(rec.id, store);
    expect(await getVaultPackage(rec.id, store)).toBeNull();
  });

  it("returns null for unknown or malformed ids", async () => {
    expect(await getVaultPackage("0".repeat(32), store)).toBeNull();
    expect(await getVaultPackage("not-an-id", store)).toBeNull();
  });

  it("rejects records whose agent key was tampered with", async () => {
    const rec = await stashVaultPackage(input(), store);
    await store.set(
      `vault-package:${rec.id}`,
      JSON.stringify({ ...rec, agentPublicKey: "zz" }),
      60_000,
    );
    expect(await getVaultPackage(rec.id, store)).toBeNull();
  });
});

describe("validation", () => {
  it("rejects bad agent public keys", async () => {
    await expect(stashVaultPackage(input({ agentPublicKey: "zzz" }), store)).rejects.toThrow(
      /agent public key/,
    );
  });

  it("rejects bad usernames", async () => {
    await expect(stashVaultPackage(input({ agentUsername: "x" }), store)).rejects.toThrow(
      /username/,
    );
  });

  it("rejects missing intro text", async () => {
    await expect(stashVaultPackage(input({ agentIntroText: "  " }), store)).rejects.toThrow(
      /intro text/,
    );
  });

  it("rejects budget outside 0.1–25", async () => {
    await expect(stashVaultPackage(input({ budgetHbar: 0.05 }), store)).rejects.toThrow(
      /out of range/,
    );
    await expect(stashVaultPackage(input({ budgetHbar: 26 }), store)).rejects.toThrow(
      /out of range/,
    );
  });

  it("accepts the dynamic floor budget (e.g. 1.5 HBAR)", async () => {
    const rec = await stashVaultPackage(input({ budgetHbar: 1.5 }), store);
    expect(rec.budgetHbar).toBe(1.5);
  });
});

describe("rate limiting", () => {
  it("allows 3 setups per day per agent key, rejects the 4th", async () => {
    expect(VAULT_PACKAGE_DAILY_LIMIT).toBe(3);
    for (let i = 0; i < 3; i++) {
      await stashVaultPackage(input(), store);
    }
    await expect(stashVaultPackage(input(), store)).rejects.toThrow(/rate limited/);
  });

  it("a different agent key gets its own quota", async () => {
    for (let i = 0; i < 3; i++) {
      await stashVaultPackage(input(), store);
    }
    const rec = await stashVaultPackage(input({ agentPublicKey: "c".repeat(64) }), store);
    expect(rec.id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("privacy", () => {
  it("never stores a private key field — schema has no room for one", async () => {
    const rec = await stashVaultPackage(input(), store);
    const raw = await store.get(`vault-package:${rec.id}`);
    expect(raw).toBeTruthy();
    const lower = raw!.toLowerCase();
    expect(lower).not.toContain("private");
    expect(lower).not.toContain("seed");
    expect(lower).not.toContain("mnemonic");
    // And the TypeScript input type physically has no such field.
    expect("agentPrivateKey" in rec).toBe(false);
    expect("privateKey" in rec).toBe(false);
  });
});
