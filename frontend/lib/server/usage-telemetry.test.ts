/**
 * Tests for internal usage telemetry (lib/server/usage-telemetry.ts).
 *
 * Privacy is the product here: events are allowlisted, context is
 * scrubbed to shape, and no identifier can reach storage.
 */
import { describe, expect, it } from "vitest";
import {
  createUsageStore,
  dayKey,
  isUsageEvent,
  scrubContext,
  USAGE_EVENTS,
} from "./usage-telemetry";

function memKv() {
  const m = new Map<string, string>();
  return {
    async get(k: string) {
      return m.get(k) ?? null;
    },
    async set(k: string, v: string) {
      m.set(k, v);
    },
  };
}

describe("isUsageEvent", () => {
  it("accepts every declared event", () => {
    for (const e of USAGE_EVENTS) expect(isUsageEvent(e)).toBe(true);
  });
  it("rejects unknown / non-string events", () => {
    expect(isUsageEvent("buddy.read_dms")).toBe(false);
    expect(isUsageEvent("page_published")).toBe(false);
    expect(isUsageEvent(42)).toBe(false);
    expect(isUsageEvent(null)).toBe(false);
  });
});

describe("scrubContext", () => {
  it("keeps allowlisted detail + sid", () => {
    expect(scrubContext({ detail: "hero", sid: "abc123" })).toEqual({
      detail: "hero",
      sid: "abc123",
    });
  });
  it("drops wallets, usernames, and junk keys", () => {
    const out = scrubContext({
      detail: "hero",
      wallet: "0.0.123",
      username: "someone",
      message: "hello buddy",
    });
    expect(out).toEqual({ detail: "hero" });
  });
  it("rejects oversized detail and malformed sid", () => {
    expect(scrubContext({ detail: "x".repeat(65) })).toEqual({});
    expect(scrubContext({ sid: "not a valid sid!!" })).toEqual({});
  });
  it("handles non-objects", () => {
    expect(scrubContext(null)).toEqual({});
    expect(scrubContext("hero")).toEqual({});
  });
});

describe("dayKey", () => {
  it("formats UTC YYYY-MM-DD", () => {
    expect(dayKey(new Date("2026-10-02T23:30:00Z"))).toBe("2026-10-02");
  });
});

describe("usage store", () => {
  it("counts, samples, and previews round-trip", async () => {
    const store = createUsageStore(memKv());
    await store.incrCount("builder.open", "2026-10-02");
    await store.incrCount("builder.open", "2026-10-02");
    const counts = await store.getCounts("2026-10-02");
    expect(counts["builder.open"]).toBe(2);
    expect(counts["buddy.open"]).toBe(0);

    await store.pushSample({ event: "buddy.message_failed", detail: "timeout", at: 1 });
    const samples = await store.getSamples("buddy.message_failed");
    expect(samples).toHaveLength(1);
    expect(samples[0].detail).toBe("timeout");

    await store.pushPreview({ blocks: [] }, 7);
    const previews = await store.getPreviews();
    expect(previews).toHaveLength(1);
    expect(previews[0].at).toBe(7);
  });

  it("caps samples and previews", async () => {
    const store = createUsageStore(memKv());
    for (let i = 0; i < 60; i++) {
      await store.pushSample({ event: "builder.open", at: i });
      await store.pushPreview({ n: i }, i);
    }
    expect((await store.getSamples("builder.open")).length).toBeLessThanOrEqual(50);
    expect((await store.getPreviews()).length).toBeLessThanOrEqual(20);
  });
});
