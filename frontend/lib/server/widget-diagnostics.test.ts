import { describe, expect, it } from "vitest";
import {
  getWidgetStats,
  getWidgetIid,
  IID_MAX_LEN,
  IID_UNATTRIBUTED,
  isUsableIid,
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
    await logWidgetVisit(wid, undefined, store);
    const stats = await getWidgetStats(store);
    expect(stats.issued).toBe(1);
    expect(stats.visited).toBe(1);
  });

  it("ignores invalid wids", async () => {
    const store = createMemoryKvStore();
    await logWidgetIssued("junk", store);
    await logWidgetVisit("junk", undefined, store);
    expect(await wasWidgetIssued("junk", store)).toBe(false);
    const stats = await getWidgetStats(store);
    expect(stats.issued).toBe(0);
    expect(stats.visited).toBe(0);
  });

  it("visit without issuance still counts (beacon is best-effort)", async () => {
    const store = createMemoryKvStore();
    const wid = mintWidgetId();
    await logWidgetVisit(wid, undefined, store);
    const stats = await getWidgetStats(store);
    expect(stats.visited).toBe(1);
  });
});

describe("iid attribution (autonomaavalix's ask)", () => {
  it("stores a usable iid alongside the visit", async () => {
    const store = createMemoryKvStore();
    const wid = mintWidgetId();
    await logWidgetVisit(wid, "req-123", store);
    expect(await getWidgetIid(wid, store)).toBe("req-123");
  });

  it("missing iid lands in the explicit unattributed bucket, not a null", async () => {
    const store = createMemoryKvStore();
    const wid = mintWidgetId();
    await logWidgetVisit(wid, undefined, store);
    expect(await getWidgetIid(wid, store)).toBe(IID_UNATTRIBUTED);
  });

  it("empty and oversized iids are unattributed too", async () => {
    const store = createMemoryKvStore();
    const wid1 = mintWidgetId();
    const wid2 = mintWidgetId();
    await logWidgetVisit(wid1, "", store);
    await logWidgetVisit(wid2, "x".repeat(IID_MAX_LEN + 1), store);
    expect(await getWidgetIid(wid1, store)).toBe(IID_UNATTRIBUTED);
    expect(await getWidgetIid(wid2, store)).toBe(IID_UNATTRIBUTED);
  });

  it("counts unattributed visits separately", async () => {
    const store = createMemoryKvStore();
    await logWidgetVisit(mintWidgetId(), "req-1", store);
    await logWidgetVisit(mintWidgetId(), undefined, store);
    await logWidgetVisit(mintWidgetId(), "", store);
    const raw = await store.get("widget:stats:unattributed");
    expect(raw).toBe("2");
    const stats = await getWidgetStats(store);
    expect(stats.visited).toBe(3);
  });

  it("isUsableIid accepts caller keys, rejects junk", () => {
    expect(isUsableIid("abc-123")).toBe(true);
    expect(isUsableIid("")).toBe(false);
    expect(isUsableIid(undefined)).toBe(false);
    expect(isUsableIid("x".repeat(IID_MAX_LEN + 1))).toBe(false);
    expect(isUsableIid(42)).toBe(false);
  });

  it("getWidgetIid returns null for unknown or invalid wids", async () => {
    const store = createMemoryKvStore();
    expect(await getWidgetIid(mintWidgetId(), store)).toBe(null);
    expect(await getWidgetIid("junk", store)).toBe(null);
  });
});
