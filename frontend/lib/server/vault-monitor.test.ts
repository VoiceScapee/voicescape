/**
 * Tests for vault-monitor: key-set parsing, health evaluation, activity
 * flags, exact-string cursors. All mirror calls are injected fakes.
 */
import { describe, it, expect } from "vitest";
import { PrivateKey } from "@hiero-ledger/sdk";
import {
  parseKeySet,
  keySetsEqual,
  registerVaultWatch,
  getVaultWatch,
  checkVaultHealth,
  scanVault,
  scanActivity,
  VAULT_LOW_BALANCE_HBAR,
} from "./vault-monitor";
import type { KvStore } from "./store";

const human = PrivateKey.generateED25519();
const agent = PrivateKey.generateED25519();
const stranger = PrivateKey.generateED25519();
const humanHex = human.publicKey.toStringRaw().toLowerCase();
const agentHex = agent.publicKey.toStringRaw().toLowerCase();
const strangerHex = stranger.publicKey.toStringRaw().toLowerCase();

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

function thresholdKey(hexes: string[]) {
  return {
    _type: "ThresholdKey",
    threshold: 1,
    keys: hexes.map((key) => ({ _type: "ED25519", key })),
  };
}

/** Fake mirror fetch: route by URL substring. */
function fakeMirror(opts: {
  account?: { status?: number; key?: any; balanceTinybars?: number } | null;
  transactions?: Array<Record<string, any>>;
}) {
  return (async (url: string) => {
    const u = String(url);
    if (u.includes("/accounts/")) {
      if (opts.account === null) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      const a = opts.account ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => ({
          account: "0.0.5555",
          key: a.key ?? thresholdKey([humanHex, agentHex]),
          balance: { balance: a.balanceTinybars ?? 500_000_000 },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ transactions: opts.transactions ?? [] }),
    };
  }) as unknown as typeof fetch;
}

async function watchedStore(
  store: KvStore,
  over: Record<string, unknown> = {},
) {
  await registerVaultWatch(
    {
      vaultId: "0.0.5555",
      humanAccountId: "0.0.7777",
      humanKeyHex: humanHex,
      humanKeyType: "ED25519",
      agentKeyHex: agentHex,
      agentUsername: "thechomps",
      ...over,
    },
    store,
  );
}

describe("parseKeySet", () => {
  it("parses a simple key", () => {
    const ks = parseKeySet({ _type: "ED25519", key: humanHex });
    expect(ks).toEqual([{ hex: humanHex, keyType: "ED25519" }]);
  });

  it("unwraps ThresholdKey and KeyList", () => {
    const ks = parseKeySet(thresholdKey([humanHex, agentHex]));
    expect(ks).toHaveLength(2);
    expect(ks!.map((k) => k.hex).sort()).toEqual([agentHex, humanHex].sort());
  });

  it("returns null for hollow and opaque keys", () => {
    expect(parseKeySet(null)).toBeNull();
    expect(parseKeySet(undefined)).toBeNull();
    expect(parseKeySet({ _type: "ProtobufEncoded", key: "aabb" })).toBeNull();
  });

  it("returns null when any sub-key is unreadable (poisoned set)", () => {
    expect(
      parseKeySet(thresholdKey([humanHex]) as any),
    ).not.toBeNull();
    const poisoned = {
      _type: "ThresholdKey",
      threshold: 1,
      keys: [
        { _type: "ED25519", key: humanHex },
        { _type: "ProtobufEncoded", key: "aabb" },
      ],
    };
    expect(parseKeySet(poisoned)).toBeNull();
  });
});

describe("keySetsEqual", () => {
  it("is order-independent", () => {
    const a = [{ hex: humanHex, keyType: "ED25519" }, { hex: agentHex, keyType: "ED25519" }];
    const b = [{ hex: agentHex, keyType: "ED25519" }, { hex: humanHex, keyType: "ED25519" }];
    expect(keySetsEqual(a, b)).toBe(true);
  });

  it("rejects different lengths and different members", () => {
    const a = [{ hex: humanHex, keyType: "ED25519" }];
    const b = [{ hex: agentHex, keyType: "ED25519" }];
    expect(keySetsEqual(a, b)).toBe(false);
    expect(keySetsEqual(a, [...a, ...b])).toBe(false);
  });
});

describe("checkVaultHealth — watched vault", () => {
  it("reports healthy when the key matches and balance is fine", async () => {
    const store = memStore();
    await watchedStore(store);
    const h = await checkVaultHealth("0.0.5555", store, fakeMirror({}));
    expect(h.status).toBe("healthy");
    expect(h.watched).toBe(true);
    expect(h.balanceHbar).toBe(5);
    expect(h.keyHealth.match).toBe(true);
    expect(h.flags).toEqual([]);
    expect(h.guidance).toContain("Nothing to do");
  });

  it("reports revoked (safe end-state) when the key is human-only", async () => {
    const store = memStore();
    await watchedStore(store);
    const h = await checkVaultHealth(
      "0.0.5555",
      store,
      fakeMirror({ account: { key: { _type: "ED25519", key: humanHex } } }),
    );
    expect(h.status).toBe("revoked");
    expect(h.keyHealth.match).toBe(false);
    expect(h.flags).toContain("revoked");
    expect(h.statusDetail).toContain("cryptographically dead");
  });

  it("reports key-changed CRITICAL when the key is something unexpected", async () => {
    const store = memStore();
    await watchedStore(store);
    const h = await checkVaultHealth(
      "0.0.5555",
      store,
      fakeMirror({ account: { key: { _type: "ED25519", key: strangerHex } } }),
    );
    expect(h.status).toBe("key-changed");
    expect(h.statusDetail).toContain("CRITICAL");
    expect(h.guidance).toContain("revocation");
  });

  it("reports low-balance below the floor", async () => {
    const store = memStore();
    await watchedStore(store);
    expect(VAULT_LOW_BALANCE_HBAR).toBe(1);
    const h = await checkVaultHealth(
      "0.0.5555",
      store,
      fakeMirror({ account: { balanceTinybars: 50_000_000 } }),
    );
    expect(h.status).toBe("low-balance");
    expect(h.balanceHbar).toBe(0.5);
    expect(h.guidance).toContain("Top up");
  });

  it("reports empty at zero balance", async () => {
    const store = memStore();
    await watchedStore(store);
    const h = await checkVaultHealth(
      "0.0.5555",
      store,
      fakeMirror({ account: { balanceTinybars: 0 } }),
    );
    expect(h.status).toBe("empty");
  });

  it("reports not-found for a 404", async () => {
    const store = memStore();
    await watchedStore(store);
    const h = await checkVaultHealth("0.0.5555", store, fakeMirror({ account: null }));
    expect(h.status).toBe("not-found");
  });
});

describe("checkVaultHealth — unwatched vault", () => {
  it("reports unverified but still shows balance", async () => {
    const store = memStore();
    const h = await checkVaultHealth("0.0.5555", store, fakeMirror({}));
    expect(h.status).toBe("unverified");
    expect(h.watched).toBe(false);
    expect(h.balanceHbar).toBe(5);
    expect(h.keyHealth.match).toBeNull();
  });

  it("rejects malformed ids", async () => {
    const h = await checkVaultHealth("nope", memStore(), fakeMirror({}));
    expect(h.status).toBe("unknown");
  });
});

describe("scanActivity", () => {
  const txns = [
    {
      name: "CryptoTransfer",
      consensus_timestamp: "1789520539.844492531",
      transfers: [{ account: "0.0.5555", amount: -100_000_000 }],
    },
    {
      name: "CryptoUpdate",
      consensus_timestamp: "1789520539.844492532",
    },
    {
      name: "ContractCall",
      consensus_timestamp: "1789520539.844492533",
      entity_id: "0.0.9999999",
    },
    {
      name: "CryptoTransfer",
      consensus_timestamp: "1789520539.844492534",
      transfers: [{ account: "0.0.5555", amount: -450_000_000 }],
    },
  ];

  it("flags updates, unknown contracts, and large outflows; cursor stays an exact string", async () => {
    const { flags, cursor } = await scanActivity(
      fakeMirror({ transactions: txns }),
      "0.0.5555",
      { mode: "since-cursor", cursor: "0" },
      5,
    );
    expect(flags).toContain("key-or-account-updated-on-chain");
    expect(flags).toContain("contract-call-to-unknown:0.0.9999999");
    expect(flags.some((f) => f.startsWith("large-outflow:4.50hbar"))).toBe(true);
    // The small 1 HBAR transfer (< 50% of 5 HBAR) is NOT flagged.
    expect(flags.filter((f) => f.startsWith("large-outflow"))).toHaveLength(1);
    // Exact string — the float-rounding lesson.
    expect(cursor).toBe("1789520539.844492534");
    expect(typeof cursor).toBe("string");
  });

  it("does not flag calls to the known registry/tips contracts", async () => {
    const { flags } = await scanActivity(
      fakeMirror({
        transactions: [
          {
            name: "ContractCall",
            consensus_timestamp: "1789520539.1",
            entity_id: "0.0.10854058",
          },
        ],
      }),
      "0.0.5555",
      { mode: "since-cursor", cursor: "0" },
      5,
    );
    expect(flags).toEqual([]);
  });

  it("recent mode reads without a cursor", async () => {
    const { flags, cursor } = await scanActivity(
      fakeMirror({ transactions: txns }),
      "0.0.5555",
      { mode: "recent", limit: 10 },
      5,
    );
    expect(flags.length).toBeGreaterThan(0);
    expect(cursor).toBe("0");
  });
});

describe("scanVault (cron path)", () => {
  it("persists the cursor and surfaces a key-changed alert", async () => {
    const store = memStore();
    await watchedStore(store);
    const { health, alerts } = await scanVault(
      "0.0.5555",
      store,
      fakeMirror({
        account: { key: { _type: "ED25519", key: strangerHex } },
        transactions: [
          { name: "CryptoUpdate", consensus_timestamp: "1789520539.844492534" },
        ],
      }),
    );
    expect(health.status).toBe("key-changed");
    expect(alerts).toContain("ALERT:key-changed");
    expect(alerts).toContain("key-or-account-updated-on-chain");
    // Cursor persisted as the exact string.
    const rec = await getVaultWatch("0.0.5555", store);
    expect(rec?.cursor).toBe("1789520539.844492534");
    expect(rec?.lastStatus).toBe("key-changed");
  });

  it("a quiet healthy scan raises no alerts", async () => {
    const store = memStore();
    await watchedStore(store);
    const { alerts } = await scanVault("0.0.5555", store, fakeMirror({}));
    expect(alerts).toEqual([]);
  });
});

describe("registerVaultWatch validation", () => {
  it("rejects bad ids and bad key hex", async () => {
    const store = memStore();
    await expect(
      registerVaultWatch(
        {
          vaultId: "nope",
          humanAccountId: "0.0.7777",
          humanKeyHex: humanHex,
          humanKeyType: "ED25519",
          agentKeyHex: agentHex,
          agentUsername: null,
        },
        store,
      ),
    ).rejects.toThrow(/vault id/);
    await expect(
      registerVaultWatch(
        {
          vaultId: "0.0.5555",
          humanAccountId: "0.0.7777",
          humanKeyHex: "zz",
          humanKeyType: "ED25519",
          agentKeyHex: agentHex,
          agentUsername: null,
        },
        store,
      ),
    ).rejects.toThrow(/human key hex/);
  });
});
