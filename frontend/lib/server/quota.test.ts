/**
 * Tests for lib/server/quota.ts — pure helpers + the store-backed quotas.
 * No network, no Next.js. Uses a private in-memory store per suite so
 * tests never touch the global singleton (or Redis).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryQuotaStore,
  nextUtcMidnightIso,
  quotaLimitFromEnv,
  utcDayKey,
  type QuotaStore,
} from "./quota";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

let store: QuotaStore;
beforeEach(() => {
  store = createMemoryQuotaStore();
});

describe("utcDayKey", () => {
  it("formats the UTC calendar day", () => {
    expect(utcDayKey(new Date("2026-09-10T23:59:59.999Z"))).toBe("2026-09-10");
  });

  it("rolls over at UTC midnight, not local midnight", () => {
    // 00:30 UTC on the 11th is still the 11th's bucket regardless of the
    // server's local timezone.
    expect(utcDayKey(new Date("2026-09-11T00:30:00Z"))).toBe("2026-09-11");
  });
});

describe("nextUtcMidnightIso", () => {
  it("points at the next UTC midnight", () => {
    expect(nextUtcMidnightIso(new Date("2026-09-10T14:00:00Z"))).toBe("2026-09-11T00:00:00.000Z");
  });

  it("rolls to the next month/year at the boundary", () => {
    expect(nextUtcMidnightIso(new Date("2026-12-31T23:59:59Z"))).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("quotaLimitFromEnv", () => {
  it("parses a numeric env value", () => {
    expect(quotaLimitFromEnv("X", 5, { X: "12" })).toBe(12);
  });

  it("falls back on missing or garbage input", () => {
    expect(quotaLimitFromEnv("X", 5, {})).toBe(5);
    expect(quotaLimitFromEnv("X", 5, { X: "abc" })).toBe(5);
    expect(quotaLimitFromEnv("X", 5, { X: "-3" })).toBe(5);
    expect(quotaLimitFromEnv("X", 5, { X: "2.5" })).toBe(5);
  });
});

describe("quotaStore.consume", () => {
  it("allows up to N and refuses beyond; the refused call is counted", async () => {
    const limit = 3;
    for (let i = 1; i <= limit; i++) {
      const r = await store.consume("vibecode", A, limit);
      expect(r.allowed).toBe(true);
      expect(r.used).toBe(i);
      expect(r.limit).toBe(limit);
    }
    const refused = await store.consume("vibecode", A, limit);
    expect(refused.allowed).toBe(false);
    // Atomic INCR semantics: the refused call is still counted (it raced
    // for the unit), but nothing beyond `limit` is ever ALLOWED, so the
    // economics guarantee — 429 before any spend — holds.
    expect(refused.used).toBe(limit + 1);
    expect(refused.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    // A further call is still refused.
    expect((await store.consume("vibecode", A, limit)).allowed).toBe(false);
  });

  it("resets at the next UTC day", async () => {
    const limit = 1;
    const day1 = new Date("2026-09-10T12:00:00Z");
    expect((await store.consume("vibecode", A, limit, day1)).allowed).toBe(true);
    expect((await store.consume("vibecode", A, limit, day1)).allowed).toBe(false);
    const day2 = new Date("2026-09-11T00:00:01Z");
    const r = await store.consume("vibecode", A, limit, day2);
    expect(r.allowed).toBe(true);
    expect(r.used).toBe(1);
  });

  it("keeps separate wallets independent", async () => {
    const limit = 1;
    expect((await store.consume("vibecode", A, limit)).allowed).toBe(true);
    expect((await store.consume("vibecode", A, limit)).allowed).toBe(false);
    expect((await store.consume("vibecode", B, limit)).allowed).toBe(true);
  });

  it("keeps separate buckets independent", async () => {
    const limit = 1;
    expect((await store.consume("pin:json", A, limit)).allowed).toBe(true);
    expect((await store.consume("pin:audio", A, limit)).allowed).toBe(true);
  });

  it("a zero limit denies everything", async () => {
    const r = await store.consume("vibecode", A, 0);
    expect(r.allowed).toBe(false);
    expect(r.used).toBe(1);
  });
});
