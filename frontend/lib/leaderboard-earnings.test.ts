/**
 * Tests for aggregateEarnings (lib/leaderboard.ts): per-creator tip windows
 * over decoded TipSent events.
 */
import { describe, expect, it } from "vitest";
import { aggregateEarnings, type TipEvent } from "./leaderboard";

const OWNER = "0x" + "aa".repeat(20);
const TIPPER_A = "0x" + "bb".repeat(20);
const TIPPER_B = "0x" + "cc".repeat(20);
const OTHER = "0x" + "dd".repeat(20);

// Fixed "now" so windows are deterministic: 2026-09-13T12:00:00Z.
const NOW_MS = Date.UTC(2026, 8, 13, 12, 0, 0);

function tip(from: string, to: string, hbar: number, atMs: number): TipEvent {
  return {
    from,
    to,
    amountHbar: hbar,
    timestamp: `${Math.floor(atMs / 1000)}.000000000`,
  };
}

const D = 86_400_000;

describe("aggregateEarnings", () => {
  it("is empty for no events", () => {
    expect(aggregateEarnings([], OWNER, NOW_MS)).toEqual({
      hbar7d: 0,
      hbar30d: 0,
      hbarAllTime: 0,
      tipCount7d: 0,
      tipCount30d: 0,
      uniqueTippers30d: 0,
    });
  });

  it("buckets events into 7d / 30d / all-time windows", () => {
    const events = [
      tip(TIPPER_A, OWNER, 1, NOW_MS - 3 * D), // in 7d + 30d
      tip(TIPPER_B, OWNER, 2, NOW_MS - 10 * D), // in 30d only
      tip(TIPPER_A, OWNER, 4, NOW_MS - 40 * D), // all-time only
    ];
    const s = aggregateEarnings(events, OWNER, NOW_MS);
    expect(s.hbar7d).toBeCloseTo(1, 8);
    expect(s.hbar30d).toBeCloseTo(3, 8);
    expect(s.hbarAllTime).toBeCloseTo(7, 8);
    expect(s.tipCount7d).toBe(1);
    expect(s.tipCount30d).toBe(2);
    expect(s.uniqueTippers30d).toBe(2);
  });

  it("counts a tip at exactly the cutoff as inside the window", () => {
    const events = [tip(TIPPER_A, OWNER, 1, NOW_MS - 7 * D)];
    const s = aggregateEarnings(events, OWNER, NOW_MS);
    expect(s.tipCount7d).toBe(1);
    expect(s.hbar7d).toBeCloseTo(1, 8);
  });

  it("ignores tips to other recipients and repeats count as one tipper", () => {
    const events = [
      tip(TIPPER_A, OTHER, 100, NOW_MS - D), // not mine
      tip(TIPPER_A, OWNER, 1, NOW_MS - D),
      tip(TIPPER_A, OWNER, 1, NOW_MS - 2 * D), // same tipper again
    ];
    const s = aggregateEarnings(events, OWNER, NOW_MS);
    expect(s.hbar30d).toBeCloseTo(2, 8);
    expect(s.tipCount30d).toBe(2);
    expect(s.uniqueTippers30d).toBe(1);
  });

  it("matches addresses case-insensitively", () => {
    const events = [tip(TIPPER_A, OWNER.toUpperCase(), 5, NOW_MS - D)];
    const s = aggregateEarnings(events, OWNER, NOW_MS);
    expect(s.hbar7d).toBeCloseTo(5, 8);
  });
});
