import { describe, expect, test } from "vitest";
import { createMemoryKvStore, type KvStore } from "./store";
import {
  CONVERSION_EVENTS,
  CONVERSION_TTL_MS,
  getConversionStats,
  getConversionStatsAdmin,
  isConversionEvent,
  recordConversion,
  type ConversionAdminDeps,
} from "./conversion";

function mem(): KvStore {
  return createMemoryKvStore();
}

describe("isConversionEvent", () => {
  test("allowlist is tight", () => {
    expect(isConversionEvent("tip_attempt")).toBe(true);
    expect(isConversionEvent("tip_confirmed")).toBe(true);
    expect(isConversionEvent("purchase_failed")).toBe(true);
    expect(isConversionEvent("wallet")).toBe(false);
    expect(isConversionEvent("tip_attempt; DROP")).toBe(false);
    expect(isConversionEvent(null)).toBe(false);
    expect(isConversionEvent(123)).toBe(false);
  });
});

describe("recordConversion", () => {
  test("increments daily counters per event", async () => {
    const store = mem();
    const t0 = Date.UTC(2026, 8, 11, 12, 0, 0);
    expect(await recordConversion(store, "tip_attempt", t0)).toBe(true);
    expect(await recordConversion(store, "tip_attempt", t0)).toBe(true);
    expect(await recordConversion(store, "tip_confirmed", t0)).toBe(true);
    const raw = await store.get("metrics:daily:2026-09-11:tip_attempt");
    expect(raw).toBe("2");
    expect(await store.get("metrics:daily:2026-09-11:tip_confirmed")).toBe("1");
  });

  test("drops non-allowlisted events silently", async () => {
    const store = mem();
    expect(await recordConversion(store, "evil_event")).toBe(false);
    expect(await recordConversion(store, null)).toBe(false);
  });

  test("never throws on a broken store (telemetry fails open)", async () => {
    const broken: KvStore = {
      incr: async () => { throw new Error("down"); },
      setNx: async () => { throw new Error("down"); },
      set: async () => { throw new Error("down"); },
      get: async () => { throw new Error("down"); },
      del: async () => { throw new Error("down"); },
      clearPrefix: async () => { throw new Error("down"); },
    };
    await expect(recordConversion(broken, "tip_attempt")).resolves.toBe(false);
  });

  test("TTL is 7 days", () => {
    expect(CONVERSION_TTL_MS).toBe(7 * 24 * 3600 * 1000);
  });

  test("stored keys carry no identity — only date + allowlisted event name", async () => {
    const store = mem();
    await recordConversion(store, "tip_attempt", Date.UTC(2026, 8, 11, 12, 0, 0));
    // The memory store exposes keys only via get; assert the exact key shape.
    const val = await store.get("metrics:daily:2026-09-11:tip_attempt");
    expect(val).toBe("1");
    // Event names are short snake_case labels — never wallet ids, IPs,
    // addresses, account ids, or tx hashes.
    for (const e of CONVERSION_EVENTS) {
      expect(e).toMatch(/^[a-z_]+$/);
      expect(e).not.toMatch(/0x[0-9a-f]{2,}|0\.0\.\d+|\d+\.\d+\.\d+\.\d+/i);
    }
  });
});

describe("getConversionStats", () => {
  test("returns last-7-day per-event totals, newest first", async () => {
    const store = mem();
    const t0 = Date.UTC(2026, 8, 11, 12, 0, 0);
    await recordConversion(store, "tip_attempt", t0);
    await recordConversion(store, "tip_attempt", t0);
    await recordConversion(store, "chat_sent", t0 - 86400_000);
    const days = await getConversionStats(store, 7, t0);
    expect(days).toHaveLength(7);
    expect(days[0].date).toBe("2026-09-11");
    expect(days[0].events).toEqual({ tip_attempt: 2 });
    expect(days[1].date).toBe("2026-09-10");
    expect(days[1].events).toEqual({ chat_sent: 1 });
    expect(days[2].events).toEqual({});
  });
});

describe("getConversionStatsAdmin", () => {
  const deps = (over: Partial<ConversionAdminDeps> = {}): ConversionAdminDeps => ({
    store: mem(),
    verifySession: async () => ({ ok: true as const, address: "0.0.10424063" }),
    env: {},
    ...over,
  });

  test("401 without credentials", async () => {
    const res = await getConversionStatsAdmin(deps(), null);
    expect(res.status).toBe(401);
  });

  test("403 for non-founder wallet", async () => {
    const res = await getConversionStatsAdmin(
      deps({ verifySession: async () => ({ ok: true as const, address: "0.0.12345" }) }),
      "token",
    );
    expect(res.status).toBe(403);
  });

  test("200 with stats for founder wallet", async () => {
    const d = deps();
    await recordConversion(d.store, "tip_confirmed");
    const res = await getConversionStatsAdmin(d, "token");
    expect(res.status).toBe(200);
    const json = res.json as { days: { date: string; events: Record<string, number> }[]; dayCount: number };
    expect(json.dayCount).toBe(7);
    expect(json.days).toHaveLength(7);
    const total = json.days.reduce((n, day) => n + (day.events.tip_confirmed ?? 0), 0);
    expect(total).toBe(1);
  });
});
