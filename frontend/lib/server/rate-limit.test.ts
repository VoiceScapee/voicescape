/**
 * Per-IP fixed-window rate limiter tests. The shared store is the memory
 * backend here (no Upstash env), so the logic is exercised directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkIpRateLimit,
  clientIpFromHeaders,
  ipRateLimitWindowMs,
} from "./rate-limit";
import { resetKvStoreSingleton } from "./store";

const WINDOW = 3_600_000;

beforeEach(async () => {
  await resetKvStoreSingleton();
});

describe("clientIpFromHeaders", () => {
  it("takes the first x-forwarded-for entry", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" });
    expect(clientIpFromHeaders(h)).toBe("203.0.113.7");
  });
  it("falls back to x-real-ip", () => {
    const h = new Headers({ "x-real-ip": "2001:db8::1" });
    expect(clientIpFromHeaders(h)).toBe("2001:db8::1");
  });
  it("collapses junk to the unknown bucket", () => {
    const h = new Headers();
    expect(clientIpFromHeaders(h)).toBe("unknown");
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "not an ip!!" }))).toBe("unknown");
  });
});

describe("checkIpRateLimit", () => {
  it("allows up to the limit, then refuses", async () => {
    const t0 = 1_700_000_000_000;
    expect((await checkIpRateLimit("1.2.3.4", "townhall", 2, WINDOW, t0)).allowed).toBe(true);
    expect((await checkIpRateLimit("1.2.3.4", "townhall", 2, WINDOW, t0)).allowed).toBe(true);
    const r = await checkIpRateLimit("1.2.3.4", "townhall", 2, WINDOW, t0);
    expect(r.allowed).toBe(false);
    expect(r.used).toBe(3);
    expect(r.retryAfterMs).toBe(WINDOW - (t0 % WINDOW));
  });

  it("resets in the next window", async () => {
    const t0 = 1_700_000_000_000;
    await checkIpRateLimit("5.6.7.8", "pin", 1, WINDOW, t0);
    expect((await checkIpRateLimit("5.6.7.8", "pin", 1, WINDOW, t0)).allowed).toBe(false);
    const next = t0 + WINDOW;
    expect((await checkIpRateLimit("5.6.7.8", "pin", 1, WINDOW, next)).allowed).toBe(true);
  });

  it("keeps buckets and IPs independent", async () => {
    const t0 = 1_700_000_000_000;
    await checkIpRateLimit("9.9.9.9", "townhall", 1, WINDOW, t0);
    expect((await checkIpRateLimit("9.9.9.9", "townhall", 1, WINDOW, t0)).allowed).toBe(false);
    // Different bucket: fresh counter.
    expect((await checkIpRateLimit("9.9.9.9", "vibecode", 1, WINDOW, t0)).allowed).toBe(true);
    // Different IP: fresh counter.
    expect((await checkIpRateLimit("8.8.8.8", "townhall", 1, WINDOW, t0)).allowed).toBe(true);
  });

  it("unknown-IP callers share one conservative bucket", async () => {
    const t0 = 1_700_000_000_000;
    await checkIpRateLimit("", "townhall", 1, WINDOW, t0);
    expect((await checkIpRateLimit("garbage!!", "townhall", 1, WINDOW, t0)).allowed).toBe(false);
  });

  it("is atomic under concurrent bursts (no lost increments)", async () => {
    const t0 = 1_700_000_000_000;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkIpRateLimit("10.0.0.1", "burst", 10, WINDOW, t0)),
    );
    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(10);
    // All 20 attempts were counted even though only 10 were allowed.
    expect(Math.max(...results.map((r) => r.used))).toBe(20);
  });

  it("fails closed: a broken store throws instead of allowing", async () => {
    const { getKvStore } = await import("./store");
    const store = getKvStore();
    vi.spyOn(store, "incr").mockRejectedValueOnce(new Error("redis down"));
    await expect(checkIpRateLimit("1.1.1.1", "townhall", 5, WINDOW)).rejects.toThrow(/redis down/);
  });

  it("reads the window size from env", () => {
    process.env.IP_RATE_LIMIT_WINDOW_MS = "60000";
    expect(ipRateLimitWindowMs()).toBe(60000);
    delete process.env.IP_RATE_LIMIT_WINDOW_MS;
    expect(ipRateLimitWindowMs()).toBe(3_600_000);
  });
});
