/**
 * NetworkPulse logic tests: one real block = one motion, never merged,
 * never simulated; big gaps resync silently; malformed mirror responses
 * are rejected so the UI goes silent instead of guessing.
 */
import { describe, expect, it } from "vitest";
import {
  planBlockPulses,
  parseLatestBlock,
  parseLatestBlockInfo,
  formatBlockAgo,
  formatBlockNumber,
} from "./network-pulse";

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
      parseLatestBlock({
        blocks: [
          {
            number: 100207911,
            timestamp: {
              from: "1727457600.123456789",
              to: "1727457602.123456789",
            },
          },
        ],
      }),
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
    // Number without a usable timestamp is malformed — the freshness
    // readout must never guess.
    expect(parseLatestBlock({ blocks: [{ number: 100207911 }] })).toBeNull();
    expect(
      parseLatestBlock({ blocks: [{ number: 100207911, timestamp: {} }] }),
    ).toBeNull();
    expect(
      parseLatestBlock({
        blocks: [{ number: 100207911, timestamp: { from: "not-a-time" } }],
      }),
    ).toBeNull();
  });
});

describe("parseLatestBlockInfo", () => {
  const good = {
    blocks: [
      {
        number: 100458020,
        timestamp: { from: "1727457600.500000000", to: "1727457602.000000000" },
      },
    ],
  };

  it("extracts number and consensus timestamp in ms (second precision)", () => {
    expect(parseLatestBlockInfo(good)).toEqual({
      number: 100458020,
      timestampMs: 1727457600000,
    });
  });

  it("accepts the legacy bare-string timestamp shape", () => {
    expect(
      parseLatestBlockInfo({
        blocks: [{ number: 7, timestamp: "1727457600.000000000" }],
      }),
    ).toEqual({ number: 7, timestampMs: 1727457600000 });
  });

  it("rejects malformed shapes", () => {
    expect(parseLatestBlockInfo(null)).toBeNull();
    expect(parseLatestBlockInfo({ blocks: [] })).toBeNull();
    expect(
      parseLatestBlockInfo({ blocks: [{ number: 1, timestamp: null }] }),
    ).toBeNull();
    expect(
      parseLatestBlockInfo({
        blocks: [{ number: 1, timestamp: { from: "0.0" } }],
      }),
    ).toBeNull();
  });
});

describe("formatBlockAgo", () => {
  it("renders seconds, minutes, hours", () => {
    const now = 1_727_457_600_000;
    expect(formatBlockAgo(now - 3_000, now)).toBe("3s");
    expect(formatBlockAgo(now - 45_000, now)).toBe("45s");
    expect(formatBlockAgo(now - 90_000, now)).toBe("1m");
    expect(formatBlockAgo(now - 3_600_000, now)).toBe("1h");
  });

  it("never claims the future on clock skew", () => {
    const now = 1_727_457_600_000;
    expect(formatBlockAgo(now + 60_000, now)).toBe("0s");
  });
});

describe("formatBlockNumber", () => {
  it("comma-groups for humans", () => {
    expect(formatBlockNumber(100458020)).toBe("100,458,020");
    expect(formatBlockNumber(42)).toBe("42");
  });
});
