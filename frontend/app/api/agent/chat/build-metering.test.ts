/**
 * build-metering tests: mirror-node TipSent discovery, the 5-HBAR floor,
 * exactly-once credit/spend, failed drafts never consuming, and the
 * operator bypass. The shared store is an injected in-memory KvStore —
 * tests never touch the global singleton or the network (fetch mocked).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUILD_PAYWALL_UNPAID,
  BUILD_PRICE_TINYBAR,
  checkBuildAccess,
  consumeBuild,
} from "./build-metering";
import { createMemoryKvStore, type KvStore } from "@/lib/server/store";

const EVM_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVM_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const FIVE_HBAR_WEI = 5_000_000_000_000_000_000n;
const FEE_WEI = 100_000_000_000_000_000n; // 2% of 5 HBAR

function tipLog(timestamp: string, index: number, amountWei: bigint = FIVE_HBAR_WEI) {
  const amount = amountWei.toString(16).padStart(64, "0");
  const fee = FEE_WEI.toString(16).padStart(64, "0");
  return {
    data: "0x" + amount + fee,
    timestamp,
    transaction_index: index,
  };
}

let store: KvStore;
let mirrorLogs: Array<Record<string, unknown>>[];
let mirrorCalls = 0;

function mockMirror(logBatches: Array<Record<string, unknown>>[]) {
  mirrorLogs = [...logBatches];
  mirrorCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/contracts/0.0.10854060/results/logs")) {
        mirrorCalls++;
        const logs = mirrorLogs.shift() ?? [];
        return { ok: true, json: async () => ({ logs }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${u}`);
    })
  );
}

beforeEach(() => {
  store = createMemoryKvStore();
  vi.stubEnv("BUDDY_OPERATOR", "");
  mockMirror([]);
});

describe("checkBuildAccess", () => {
  it("denies when the wallet never tipped forge", async () => {
    mockMirror([[]]);
    const access = await checkBuildAccess(EVM_A, store);
    expect(access).toEqual({ allowed: false, reason: BUILD_PAYWALL_UNPAID });
  });

  it("allows after discovering a 5-HBAR tip, and remembers it", async () => {
    mockMirror([[tipLog("1789520539.844492534", 3)]]);
    expect(await checkBuildAccess(EVM_A, store)).toEqual({ allowed: true });
    // Second call: the ledger already has the payment — no mirror call needed.
    const callsBefore = mirrorCalls;
    expect(await checkBuildAccess(EVM_A, store)).toEqual({ allowed: true });
    expect(mirrorCalls).toBe(callsBefore);
  });

  it("ignores tips below 5 HBAR", async () => {
    mockMirror([[tipLog("1789520539.844492534", 3, FIVE_HBAR_WEI - 1n)]]);
    const access = await checkBuildAccess(EVM_A, store);
    expect(access.allowed).toBe(false);
  });

  it("treats a mirror-node hiccup as unpaid, never as paid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("mirror down");
      })
    );
    const access = await checkBuildAccess(EVM_A, store);
    expect(access.allowed).toBe(false);
  });

  it("credits the same on-chain payment only once across calls", async () => {
    const log = tipLog("1789520539.844492534", 3);
    mockMirror([[log], [log]]);
    expect(await checkBuildAccess(EVM_A, store)).toEqual({ allowed: true });
    // A concurrent discoverer racing the same payment must not double-credit.
    const again = await checkBuildAccess(EVM_A, store);
    expect(again).toEqual({ allowed: true });
    const raw = await store.get(`buddy:chat:${EVM_A}`);
    const payments = JSON.parse(raw!).payments as Array<{ id: string }>;
    expect(payments).toHaveLength(1);
  });

  it("keeps wallets separate", async () => {
    mockMirror([[tipLog("1789520539.844492534", 3)]]);
    expect(await checkBuildAccess(EVM_A, store)).toEqual({ allowed: true });
    mockMirror([[]]);
    expect((await checkBuildAccess(EVM_B, store)).allowed).toBe(false);
  });
});

describe("consumeBuild", () => {
  it("spends an unused payment exactly once", async () => {
    mockMirror([[tipLog("1789520539.844492534", 3)]]);
    expect(await checkBuildAccess(EVM_A, store)).toEqual({ allowed: true });
    expect(await consumeBuild(EVM_A, store)).toBe(true);
    expect(await consumeBuild(EVM_A, store)).toBe(false);
  });

  it("resolves false when nothing was ever paid", async () => {
    expect(await consumeBuild(EVM_A, store)).toBe(false);
  });

  it("lets exactly one concurrent build win the last payment", async () => {
    mockMirror([[tipLog("1789520539.844492534", 3)]]);
    expect(await checkBuildAccess(EVM_A, store)).toEqual({ allowed: true });
    const results = await Promise.all([
      consumeBuild(EVM_A, store),
      consumeBuild(EVM_A, store),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("spends a second payment for a second build", async () => {
    mockMirror([
      [
        tipLog("1789520539.844492534", 3),
        tipLog("1789520600.000000000", 7),
      ],
    ]);
    expect(await checkBuildAccess(EVM_A, store)).toEqual({ allowed: true });
    expect(await consumeBuild(EVM_A, store)).toBe(true);
    expect(await consumeBuild(EVM_A, store)).toBe(true);
    expect(await consumeBuild(EVM_A, store)).toBe(false);
  });
});

describe("meteringBypass", () => {
  it("BUDDY_OPERATOR=1 allows and spends without touching the chain", async () => {
    vi.stubEnv("BUDDY_OPERATOR", "1");
    // No fetch mock for the mirror node — any call would throw.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("must not be called");
      })
    );
    expect(await checkBuildAccess(EVM_A, store)).toEqual({ allowed: true });
    expect(await consumeBuild(EVM_A, store)).toBe(true);
  });
});

describe("pricing constant", () => {
  it("is 5 HBAR in tinybar", () => {
    expect(BUILD_PRICE_TINYBAR).toBe(500_000_000);
  });
});
