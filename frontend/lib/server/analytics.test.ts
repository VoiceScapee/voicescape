/**
 * Tests for lib/server/analytics.ts — view tracking, stats aggregation,
 * and the owner-only creator stats gate.
 */
import { describe, expect, test } from "vitest";
import { createMemoryKvStore, type KvStore } from "./store";
import {
  ANALYTICS_VIEW_TTL_MS,
  PAGE_SUBJECT,
  getCreatorStats,
  getTipsForWallet,
  getViewStats,
  labelsKey,
  normalizeLabel,
  normalizeSubject,
  normalizeUsername,
  recordPageView,
  subjectsKey,
  tinybarToHbar,
  viewDateKey,
  viewKey,
  type AnalyticsDeps,
  type TipsReceived,
} from "./analytics";

function deps(over: Partial<AnalyticsDeps> = {}): AnalyticsDeps {
  return {
    store: createMemoryKvStore(),
    verifySession: async () => ({ ok: true as const, address: "0xabc" }),
    resolveOwner: async () => "0xABC",
    tipsForWallet: async (): Promise<TipsReceived> => ({ totalTinybar: 0n, count: 0 }),
    referralCount: async () => 0,
    badgeCount: async () => 0,
    ...over,
  };
}

describe("key helpers", () => {
  test("viewDateKey is UTC YYYY-MM-DD", () => {
    expect(viewDateKey(new Date("2026-09-10T23:30:00Z"))).toBe("2026-09-10");
    expect(viewDateKey(new Date("2026-01-05T00:00:00Z"))).toBe("2026-01-05");
  });

  test("normalizeUsername lowercases and validates", () => {
    expect(normalizeUsername("Brandon")).toBe("brandon");
    expect(normalizeUsername("  agent-1 ")).toBe("agent-1");
    expect(normalizeUsername("")).toBeNull();
    expect(normalizeUsername("has space")).toBeNull();
    expect(normalizeUsername("x".repeat(65))).toBeNull();
    expect(normalizeUsername(null)).toBeNull();
    expect(normalizeUsername(42)).toBeNull();
  });

  test("normalizeSubject always returns a slug", () => {
    expect(normalizeSubject(undefined)).toBe(PAGE_SUBJECT);
    expect(normalizeSubject("")).toBe(PAGE_SUBJECT);
    expect(normalizeSubject("listing:abc123")).toBe("listing:abc123");
    expect(normalizeSubject("  Weird Subject!! ")).toBe("weirdsubject");
  });

  test("normalizeLabel trims and caps", () => {
    expect(normalizeLabel("  My Listing  ")).toBe("My Listing");
    expect(normalizeLabel("")).toBeNull();
    expect(normalizeLabel(null)).toBeNull();
    expect(normalizeLabel("x".repeat(200))).toHaveLength(120);
  });

  test("viewKey is namespaced", () => {
    expect(viewKey("brandon", "page", "2026-09-10")).toBe("analytics:views:brandon:page:2026-09-10");
    expect(subjectsKey("brandon")).toBe("analytics:subjects:brandon");
    expect(labelsKey("brandon")).toBe("analytics:labels:brandon");
  });
});

describe("recordPageView / getViewStats", () => {
  test("counts views across days and windows", async () => {
    const store = createMemoryKvStore();
    const now = Date.parse("2026-09-10T12:00:00Z");
    // today: 3, yesterday: 2, 8 days ago: 5 (outside 7d window)
    for (let i = 0; i < 3; i++) await recordPageView(store, "brandon", PAGE_SUBJECT, null, now);
    const stats0 = await getViewStats(store, "brandon", now);
    expect(stats0.totalViews).toBe(3);

    // Simulate other days by writing keys directly
    await store.incr(viewKey("brandon", "page", "2026-09-09"), ANALYTICS_VIEW_TTL_MS);
    await store.incr(viewKey("brandon", "page", "2026-09-09"), ANALYTICS_VIEW_TTL_MS);
    for (let i = 0; i < 5; i++) {
      await store.incr(viewKey("brandon", "page", "2026-09-02"), ANALYTICS_VIEW_TTL_MS);
    }
    const stats = await getViewStats(store, "brandon", now);
    expect(stats.totalViews).toBe(10);
    expect(stats.viewsLast30d).toBe(10);
    expect(stats.viewsLast7d).toBe(5); // today + yesterday
    expect(stats.daily).toHaveLength(30);
    expect(stats.daily[29]).toEqual({ date: "2026-09-10", views: 3 });
    expect(stats.daily[28]).toEqual({ date: "2026-09-09", views: 2 });
    expect(stats.topSubjects).toEqual([]);
  });

  test("subjects and labels aggregate into topSubjects", async () => {
    const store = createMemoryKvStore();
    const now = Date.parse("2026-09-10T12:00:00Z");
    await recordPageView(store, "brandon", "page", null, now);
    await recordPageView(store, "brandon", "listing:aaa", "Cool Widget", now);
    await recordPageView(store, "brandon", "listing:aaa", "Cool Widget", now);
    await recordPageView(store, "brandon", "listing:bbb", "Other Thing", now);
    const stats = await getViewStats(store, "brandon", now);
    expect(stats.totalViews).toBe(4);
    expect(stats.topSubjects).toEqual([
      { subject: "listing:aaa", label: "Cool Widget", views: 2 },
      { subject: "listing:bbb", label: "Other Thing", views: 1 },
    ]);
  });

  test("missing label reads as null", async () => {
    const store = createMemoryKvStore();
    await recordPageView(store, "brandon", "listing:xyz");
    const stats = await getViewStats(store, "brandon");
    expect(stats.topSubjects[0]).toMatchObject({ subject: "listing:xyz", label: null, views: 1 });
  });

  test("unknown user gets empty stats", async () => {
    const stats = await getViewStats(createMemoryKvStore(), "nobody");
    expect(stats.totalViews).toBe(0);
    expect(stats.daily).toHaveLength(30);
  });
});

describe("tinybarToHbar", () => {
  test("converts tinybar to HBAR", () => {
    expect(tinybarToHbar(100_000_000n)).toBe(1);
    expect(tinybarToHbar(250_000_000n)).toBe(2.5);
    expect(tinybarToHbar(0n)).toBe(0);
  });
});

describe("getTipsForWallet", () => {
  test("returns zeros without a tips contract configured", async () => {
    const prev = process.env.NEXT_PUBLIC_TIPS_ADDRESS;
    delete process.env.NEXT_PUBLIC_TIPS_ADDRESS;
    try {
      expect(await getTipsForWallet("0xabc")).toEqual({ totalTinybar: 0n, count: 0 });
    } finally {
      if (prev !== undefined) process.env.NEXT_PUBLIC_TIPS_ADDRESS = prev;
    }
  });
});

describe("getCreatorStats auth gate", () => {
  test("401 when no credential", async () => {
    const res = await getCreatorStats(deps(), "brandon", null);
    expect(res.status).toBe(401);
  });

  test("401 when session invalid", async () => {
    const res = await getCreatorStats(
      deps({ verifySession: async () => ({ ok: false as const, error: "expired" }) }),
      "brandon",
      "bad-token",
    );
    expect(res.status).toBe(401);
  });

  test("400 on bad username", async () => {
    const res = await getCreatorStats(deps(), "not a name!!", "tok");
    expect(res.status).toBe(400);
  });

  test("404 when page not registered", async () => {
    const res = await getCreatorStats(deps({ resolveOwner: async () => null }), "ghost", "tok");
    expect(res.status).toBe(404);
  });

  test("403 when session wallet is not the owner", async () => {
    const res = await getCreatorStats(
      deps({ resolveOwner: async () => "0xowner" }),
      "brandon",
      "tok",
    );
    expect(res.status).toBe(403);
  });

  test("200 happy path aggregates every source", async () => {
    const store: KvStore = createMemoryKvStore();
    const nowHp = Date.now();
    await recordPageView(store, "brandon", PAGE_SUBJECT, null, nowHp);
    await recordPageView(store, "brandon", PAGE_SUBJECT, null, nowHp);
    await recordPageView(store, "brandon", "listing:aaa", "Cool Widget", nowHp);
    const d = deps({
      store,
      tipsForWallet: async () => ({ totalTinybar: 300_000_000n, count: 2 }),
      referralCount: async () => 7,
      badgeCount: async () => 5,
    });
    const res = await getCreatorStats(d, "Brandon", "tok");
    expect(res.status).toBe(200);
    const json = res.json as Record<string, unknown>;
    expect(json.username).toBe("brandon");
    expect(json.totalViews).toBe(3);
    expect(json.totalTipsHbar).toBe(3);
    expect(json.tipsCount).toBe(2);
    expect(json.totalReferrals).toBe(7);
    expect(json.badgesEarned).toBe(5);
    expect(json.topSubjects).toEqual([{ subject: "listing:aaa", label: "Cool Widget", views: 1 }]);
  });

  test("fail-open: source errors become zeros, not 500s", async () => {
    const d = deps({
      tipsForWallet: async () => {
        throw new Error("mirror down");
      },
      referralCount: async () => {
        throw new Error("hcs down");
      },
      badgeCount: async () => {
        throw new Error("badges down");
      },
    });
    const res = await getCreatorStats(d, "brandon", "tok");
    expect(res.status).toBe(200);
    const json = res.json as Record<string, unknown>;
    expect(json.totalTipsHbar).toBe(0);
    expect(json.totalReferrals).toBe(0);
    expect(json.badgesEarned).toBe(0);
  });
});
