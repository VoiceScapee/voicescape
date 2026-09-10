/**
 * Tests for lib/server/store.ts — the shared KV abstraction.
 * Memory backend semantics; the Upstash backend speaks plain REST and is
 * exercised against the same interface via dependency injection in the
 * quota/replay tests.
 */
import { describe, expect, it } from "vitest";
import { createMemoryKvStore } from "./store";

describe("MemoryKvStore", () => {
  it("incr counts up and reports the new count", async () => {
    const s = createMemoryKvStore();
    expect(await s.incr("k", 60_000)).toBe(1);
    expect(await s.incr("k", 60_000)).toBe(2);
    expect(await s.incr("k", 60_000)).toBe(3);
  });

  it("incr keys are independent", async () => {
    const s = createMemoryKvStore();
    await s.incr("a", 60_000);
    expect(await s.incr("b", 60_000)).toBe(1);
  });

  it("setNx claims once, then rejects until released", async () => {
    const s = createMemoryKvStore();
    expect(await s.setNx("claim", "v1", 60_000)).toBe(true);
    expect(await s.setNx("claim", "v2", 60_000)).toBe(false);
    expect(await s.get("claim")).toBe("v1");
    await s.del("claim");
    expect(await s.setNx("claim", "v2", 60_000)).toBe(true);
    expect(await s.get("claim")).toBe("v2");
  });

  it("set overwrites with a fresh TTL", async () => {
    const s = createMemoryKvStore();
    await s.set("k", "a", 60_000);
    expect(await s.get("k")).toBe("a");
    await s.set("k", "b", 60_000);
    expect(await s.get("k")).toBe("b");
  });

  it("get returns null for missing keys", async () => {
    const s = createMemoryKvStore();
    expect(await s.get("nope")).toBeNull();
  });

  it("entries expire after their TTL", async () => {
    const s = createMemoryKvStore();
    await s.set("e", "x", 20);
    expect(await s.get("e")).toBe("x");
    await new Promise((r) => setTimeout(r, 40));
    expect(await s.get("e")).toBeNull();
    // An expired claim can be re-claimed.
    expect(await s.setNx("e", "y", 60_000)).toBe(true);
  });

  it("an expired incr key restarts at 1", async () => {
    const s = createMemoryKvStore();
    await s.incr("c", 20);
    await new Promise((r) => setTimeout(r, 40));
    expect(await s.incr("c", 60_000)).toBe(1);
  });

  it("clearPrefix removes only matching keys", async () => {
    const s = createMemoryKvStore();
    await s.set("vs:a:1", "x", 60_000);
    await s.set("vs:a:2", "x", 60_000);
    await s.set("vs:b:1", "x", 60_000);
    await s.clearPrefix("vs:a:");
    expect(await s.get("vs:a:1")).toBeNull();
    expect(await s.get("vs:a:2")).toBeNull();
    expect(await s.get("vs:b:1")).toBe("x");
  });

  it("rejects non-positive TTLs", async () => {
    const s = createMemoryKvStore();
    await expect(s.incr("k", 0)).rejects.toThrow();
    await expect(s.setNx("k", "v", -1)).rejects.toThrow();
    await expect(s.set("k", "v", 0)).rejects.toThrow();
  });
});
