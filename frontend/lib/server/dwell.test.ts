import { describe, expect, test } from "vitest";
import { createMemoryKvStore, type KvStore } from "./store";
import {
  dwellBucket,
  getDwellStats,
  getDwellStatsAdmin,
  isFlowId,
  isNonce,
  openDwellFlow,
  recordDwellSettled,
  recordDwellSign,
  validateDwellFlow,
  type DwellAdminDeps,
} from "./dwell";

function mem(): KvStore {
  return createMemoryKvStore();
}

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

describe("validateDwellFlow", () => {
  test("happy path: t1 <= t2 <= t3", () => {
    const v = validateDwellFlow(T0, T0 + 20_000, T0 + 25_000, T0 + 30_000);
    expect(v.ok).toBe(true);
    expect(v.violations).toEqual([]);
  });

  test("flags t2 before t1", () => {
    const v = validateDwellFlow(T0 + 10_000, T0, T0 + 20_000, T0 + 30_000);
    expect(v.ok).toBe(false);
    expect(v.violations).toContain("t2_before_t1");
  });

  test("flags t3 before t2", () => {
    const v = validateDwellFlow(T0, T0 + 20_000, T0 + 10_000, T0 + 30_000);
    expect(v.ok).toBe(false);
    expect(v.violations).toContain("t3_before_t2");
  });

  test("flags dwell exceeding the total window", () => {
    // t2-t1 = 50s but t3-t1 = 30s: dwell longer than the whole flow.
    const v = validateDwellFlow(T0, T0 + 50_000, T0 + 30_000, T0 + 60_000);
    expect(v.violations).toContain("t3_before_t2");
    expect(v.violations).toContain("dwell_exceeds_total");
  });

  test("flags t3 in the future beyond skew allowance", () => {
    const v = validateDwellFlow(T0, T0 + 5_000, T0 + 600_000, T0 + 10_000);
    expect(v.violations).toContain("t3_in_future");
  });

  test("allows t3 within the skew window", () => {
    const v = validateDwellFlow(T0, T0 + 5_000, T0 + 30_000, T0 + 10_000);
    expect(v.ok).toBe(true);
  });

  test("rejects non-finite timestamps", () => {
    const v = validateDwellFlow(T0, NaN, T0 + 10_000, T0);
    expect(v.ok).toBe(false);
  });
});

describe("dwellBucket", () => {
  test("bucket boundaries", () => {
    expect(dwellBucket(0)).toBe("lt_5s");
    expect(dwellBucket(4_999)).toBe("lt_5s");
    expect(dwellBucket(5_000)).toBe("5s_30s");
    expect(dwellBucket(29_999)).toBe("5s_30s");
    expect(dwellBucket(30_000)).toBe("30s_2m");
    expect(dwellBucket(119_999)).toBe("30s_2m");
    expect(dwellBucket(120_000)).toBe("2m_10m");
    expect(dwellBucket(599_999)).toBe("2m_10m");
    expect(dwellBucket(600_000)).toBe("gt_10m");
    expect(dwellBucket(3_600_000)).toBe("gt_10m");
  });
});

describe("id validators", () => {
  test("flow id shape", () => {
    expect(isFlowId("dfl_0123456789abcdef")).toBe(true);
    expect(isFlowId("dfl_0123456789abcde")).toBe(false);
    expect(isFlowId("dfl_0123456789abcdefg")).toBe(false);
    expect(isFlowId("wr_0123456789abcdef")).toBe(false);
    expect(isFlowId(null)).toBe(false);
  });

  test("nonce shape", () => {
    expect(isNonce("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isNonce("0123456789abcdef")).toBe(false);
    expect(isNonce(null)).toBe(false);
  });
});

describe("dwell flow lifecycle", () => {
  test("open -> sign -> settled records server timestamps and buckets dwell", async () => {
    const store = mem();
    const opened = await openDwellFlow(store, { context: "post", nowMs: T0 });
    expect(opened).not.toBeNull();
    const { flowId, nonce } = opened!;

    expect(await recordDwellSign(store, flowId, nonce, { nowMs: T0 + 22_000 })).toBe(true);
    const res = await recordDwellSettled(store, flowId, nonce, T0 + 27_000, { nowMs: T0 + 30_000 });
    expect(res.ok).toBe(true);
    expect(res.violations).toEqual([]);
    expect(res.dwellMs).toBe(22_000);
    expect(res.machineMs).toBe(5_000);

    const raw = await store.get("metrics:daily:2026-10-08:dwell:5s_30s");
    expect(raw).toBe("1");
    expect(await store.get("metrics:daily:2026-10-08:dwell_completed")).toBe("1");
  });

  test("open stamps T1 on the server clock, not client input", async () => {
    const store = mem();
    const opened = await openDwellFlow(store, { nowMs: T0 });
    const raw = await store.get(`dwell:flow:${opened!.flowId}`);
    const flow = JSON.parse(raw!);
    expect(flow.t1).toBe(T0);
    expect(flow.t2).toBeNull();
    expect(flow.t3).toBeNull();
  });

  test("sign rejects wrong nonce, unknown flow, and double-sign", async () => {
    const store = mem();
    const opened = await openDwellFlow(store, { nowMs: T0 });
    const { flowId, nonce } = opened!;
    expect(await recordDwellSign(store, flowId, "0".repeat(32), { nowMs: T0 + 1 })).toBe(false);
    expect(await recordDwellSign(store, "dfl_ffffffffffffffff", nonce, { nowMs: T0 + 1 })).toBe(false);
    expect(await recordDwellSign(store, flowId, nonce, { nowMs: T0 + 1 })).toBe(true);
    // Second sign is a replay — rejected.
    expect(await recordDwellSign(store, flowId, nonce, { nowMs: T0 + 2 })).toBe(false);
  });

  test("settled flags monotonicity violations into counters", async () => {
    const store = mem();
    const opened = await openDwellFlow(store, { nowMs: T0 });
    const { flowId, nonce } = opened!;
    await recordDwellSign(store, flowId, nonce, { nowMs: T0 + 5_000 });
    // Spoofed t3 before t2.
    const res = await recordDwellSettled(store, flowId, nonce, T0 + 1_000, { nowMs: T0 + 30_000 });
    expect(res.ok).toBe(false);
    expect(res.violations).toContain("t3_before_t2");
    const raw = await store.get("metrics:daily:2026-10-08:dwell_violation:t3_before_t2");
    expect(raw).toBe("1");
    // Violated flows don't pollute the dwell histogram.
    expect(await store.get("metrics:daily:2026-10-08:dwell_completed")).toBeNull();
  });

  test("settled without a sign event is flagged, not dropped", async () => {
    const store = mem();
    const opened = await openDwellFlow(store, { nowMs: T0 });
    const { flowId, nonce } = opened!;
    const res = await recordDwellSettled(store, flowId, nonce, T0 + 10_000, { nowMs: T0 + 30_000 });
    expect(res.ok).toBe(true);
    expect(res.violations).toContain("t3_before_t2");
  });

  test("settled rejects bad ids, bad t3, and wrong nonce", async () => {
    const store = mem();
    const opened = await openDwellFlow(store, { nowMs: T0 });
    const { flowId, nonce } = opened!;
    expect((await recordDwellSettled(store, "nope", nonce, T0 + 1, { nowMs: T0 })).ok).toBe(false);
    expect((await recordDwellSettled(store, flowId, nonce, NaN, { nowMs: T0 })).ok).toBe(false);
    expect((await recordDwellSettled(store, flowId, "0".repeat(32), T0 + 1, { nowMs: T0 })).ok).toBe(
      false,
    );
  });

  test("cohort is stored when valid, dropped when malformed", async () => {
    const store = mem();
    const good = await openDwellFlow(store, {
      cohort: "123e4567-e89b-12d3-a456-426614174000",
      nowMs: T0,
    });
    const raw = await store.get(`dwell:flow:${good!.flowId}`);
    expect(JSON.parse(raw!).cohort).toBe("123e4567-e89b-12d3-a456-426614174000");

    const bad = await openDwellFlow(store, { cohort: "not-a-uuid", nowMs: T0 });
    const rawBad = await store.get(`dwell:flow:${bad!.flowId}`);
    expect(JSON.parse(rawBad!).cohort).toBeNull();
  });

  test("open drops invalid context but still opens the flow", async () => {
    const store = mem();
    const opened = await openDwellFlow(store, { context: "evil", nowMs: T0 });
    expect(opened).not.toBeNull();
    const raw = await store.get(`dwell:flow:${opened!.flowId}`);
    expect(JSON.parse(raw!).context).toBeNull();
  });
});

describe("getDwellStats", () => {
  test("aggregates buckets, violations, and completions per day", async () => {
    const store = mem();
    const mk = async (dwellMs: number) => {
      const opened = await openDwellFlow(store, { nowMs: T0 });
      await recordDwellSign(store, opened!.flowId, opened!.nonce, { nowMs: T0 + dwellMs });
      await recordDwellSettled(store, opened!.flowId, opened!.nonce, T0 + dwellMs + 2_000, {
        nowMs: T0 + dwellMs + 5_000,
      });
    };
    await mk(2_000);
    await mk(45_000);
    await mk(45_000);

    const stats = await getDwellStats(store, 7, T0 + 3_600_000);
    const today = stats[0];
    expect(today.date).toBe("2026-10-08");
    expect(today.completed).toBe(3);
    expect(today.buckets["lt_5s"]).toBe(1);
    expect(today.buckets["30s_2m"]).toBe(2);
    expect(Object.keys(today.violations)).toEqual([]);
  });
});

describe("getDwellStatsAdmin", () => {
  const deps = (address: string | null): DwellAdminDeps => ({
    store: mem(),
    verifySession: async () =>
      address
        ? { ok: true as const, address }
        : { ok: false as const, error: "no session" },
    env: { FOUNDER_WALLETS: "0.0.10424063" },
  });

  test("401 without credential", async () => {
    const res = await getDwellStatsAdmin(deps("0.0.10424063"), null);
    expect(res.status).toBe(401);
  });

  test("401 on bad session", async () => {
    const res = await getDwellStatsAdmin(deps(null), { session: "x" });
    expect(res.status).toBe(401);
  });

  test("403 for non-founder", async () => {
    const res = await getDwellStatsAdmin(deps("0.0.999"), { session: "x" });
    expect(res.status).toBe(403);
  });

  test("200 with stats for founder", async () => {
    const store = mem();
    const opened = await openDwellFlow(store, { nowMs: T0 });
    await recordDwellSign(store, opened!.flowId, opened!.nonce, { nowMs: T0 + 8_000 });
    await recordDwellSettled(store, opened!.flowId, opened!.nonce, T0 + 12_000, {
      nowMs: T0 + 20_000,
    });
    const d: DwellAdminDeps = {
      store,
      verifySession: async () => ({ ok: true as const, address: "0.0.10424063" }),
      env: { FOUNDER_WALLETS: "0.0.10424063" },
    };
    const res = await getDwellStatsAdmin(d, { session: "x" }, T0 + 3_600_000);
    expect(res.status).toBe(200);
    const json = res.json as { days: { date: string; completed: number }[] };
    expect(json.days[0].completed).toBe(1);
  });
});

describe("tail mass (upper bound on decided-before-landing)", () => {
  test("publishes the short-dwell tail mass and fraction", async () => {
    const store = mem();
    const mk = async (dwellMs: number) => {
      const opened = await openDwellFlow(store, { nowMs: T0 });
      await recordDwellSign(store, opened!.flowId, opened!.nonce, { nowMs: T0 + dwellMs });
      await recordDwellSettled(store, opened!.flowId, opened!.nonce, T0 + dwellMs + 2_000, {
        nowMs: T0 + dwellMs + 5_000,
      });
    };
    await mk(2_000); // lt_5s — tail
    await mk(3_000); // lt_5s — tail
    await mk(45_000);
    await mk(300_000);

    const stats = await getDwellStats(store, 7, T0 + 3_600_000);
    const today = stats[0];
    expect(today.completed).toBe(4);
    expect(today.tailMass).toBe(2);
    expect(today.tailMassFraction).toBeCloseTo(0.5);
  });

  test("tail mass is zero with no completions, fraction null", async () => {
    const store = mem();
    const stats = await getDwellStats(store, 7, T0 + 3_600_000);
    expect(stats[0].tailMass).toBe(0);
    expect(stats[0].tailMassFraction).toBeNull();
  });
});
