/**
 * NetworkPulse logic tests: one real block = one motion, never merged,
 * never simulated; big gaps resync silently; malformed mirror responses
 * are rejected so the UI goes silent instead of guessing.
 */
import { describe, expect, it } from "vitest";
import { planBlockPulses, parseLatestBlock } from "./network-pulse";

describe("planBlockPulses", () => {
  it("adopts the baseline silently — never pulses for history", () => {
    expect(planBlockPulses(null, 100207911)).toEqual({ pulses: 0, resync: true });
  });

  it("stays still when the block number hasn't moved", () => {
    expect(planBlockPulses(100, 100)).toEqual({ pulses: 0, resync: false });
  });

  it("stays still if the mirror moves backwards", () => {
    expect(planBlockPulses(100, 99)).toEqual({ pulses: 0, resync: false });
  });

  it("pulses once per block for a small gap — never merged", () => {
    expect(planBlockPulses(100, 101)).toEqual({ pulses: 1, resync: false });
    expect(planBlockPulses(100, 104)).toEqual({ pulses: 4, resync: false });
  });

  it("resyncs silently past the catch-up cap (slept tab / long outage)", () => {
    expect(planBlockPulses(100, 100 + 8)).toEqual({ pulses: 8, resync: false });
    expect(planBlockPulses(100, 100 + 9)).toEqual({ pulses: 0, resync: true });
    expect(planBlockPulses(100, 999_999)).toEqual({ pulses: 0, resync: true });
  });

  it("honours a custom cap", () => {
    expect(planBlockPulses(100, 103, 2)).toEqual({ pulses: 0, resync: true });
    expect(planBlockPulses(100, 102, 2)).toEqual({ pulses: 2, resync: false });
  });
});

describe("parseLatestBlock", () => {
  it("extracts the block number from a mirror response", () => {
    expect(
      parseLatestBlock({ blocks: [{ number: 100207911, timestamp: {} }] }),
    ).toBe(100207911);
  });

  it("rejects malformed shapes so the UI goes silent", () => {
    expect(parseLatestBlock(null)).toBeNull();
    expect(parseLatestBlock({})).toBeNull();
    expect(parseLatestBlock({ blocks: [] })).toBeNull();
    expect(parseLatestBlock({ blocks: [{}] })).toBeNull();
    expect(parseLatestBlock({ blocks: [{ number: "100207911" }] })).toBeNull();
    expect(parseLatestBlock({ blocks: [{ number: -1 }] })).toBeNull();
    expect(parseLatestBlock({ blocks: [{ number: 1.5 }] })).toBeNull();
  });
});
