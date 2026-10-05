import { describe, expect, it } from "vitest";
import {
  getWidgetStats,
  isWidgetId,
  logWidgetIssued,
  logWidgetVisit,
  mintWidgetId,
  wasWidgetIssued,
} from "./widget-diagnostics";
import { createMemoryKvStore } from "./store";

describe("mintWidgetId", () => {
  it("mints 8-char unambiguous ids", () => {
    for (let i = 0; i < 20; i++) {
      const wid = mintWidgetId();
      expect(wid).toMatch(/^[A-Z2-9]{8}$/);
    }
  });

  it("mints unique ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintWidgetId()));
    expect(ids.size).toBe(50);
  });
});

describe("isWidgetId", () => {
  it("accepts minted ids, rejects junk", () => {
    expect(isWidgetId(mintWidgetId())).toBe(true);
    expect(isWidgetId("abc")).toBe(false);
    expect(isWidgetId("ABCDIFGH")).toBe(false); // I, O, L excluded
    expect(isWidgetId("")).toBe(false);
    expect(isWidgetId(null)).toBe(false);
    expect(isWidgetId(123)).toBe(false);
  });
});

describe("widget issuance/visit tracking", () => {
  it("tracks issued then visited", async () => {
    const store = createMemoryKvStore();
    const wid = mintWidgetId();
    expect(await wasWidgetIssued(wid, store)).toBe(false);
    await logWidgetIssued(wid, store);
    expect(await wasWidgetIssued(wid, store)).toBe(true);
    await logWidgetVisit(wid, store);
    const stats = await getWidgetStats(store);
    expect(stats.issued).toBe(1);
    expect(stats.visited).toBe(1);
  });

  it("ignores invalid wids", async () => {
    const store = createMemoryKvStore();
    await logWidgetIssued("junk", store);
    await logWidgetVisit("junk", store);
    expect(await wasWidgetIssued("junk", store)).toBe(false);
    const stats = await getWidgetStats(store);
    expect(stats.issued).toBe(0);
    expect(stats.visited).toBe(0);
  });

  it("visit without issuance still counts (beacon is best-effort)", async () => {
    const store = createMemoryKvStore();
    const wid = mintWidgetId();
    await logWidgetVisit(wid, store);
    const stats = await getWidgetStats(store);
    expect(stats.visited).toBe(1);
  });
});
