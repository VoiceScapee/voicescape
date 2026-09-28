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
  parseMirrorTimestampMs,
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
  });

  it("returns the number even when the timestamp is missing/malformed", () => {
    // The pulse runs on the block number; only the freshness readout
    // needs the timestamp.
    expect(parseLatestBlock({ blocks: [{ number: 100207911 }] })).toBe(
      100207911,
    );
    expect(
      parseLatestBlock({ blocks: [{ number: 100207911, timestamp: {} }] }),
    ).toBe(100207911);
    expect(
      parseLatestBlock({
        blocks: [{ number: 100207911, timestamp: { from: "not-a-time" } }],
      }),
    ).toBe(100207911);
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

  it("extracts number and consensus timestamp in ms (millisecond precision)", () => {
    expect(parseLatestBlockInfo(good)).toEqual({
      number: 100458020,
      timestampMs: 1727457600500,
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

describe("parseMirrorTimestampMs", () => {
  it("parses whole seconds plus the first three fractional digits", () => {
    expect(parseMirrorTimestampMs("1727457600.500000000")).toBe(1727457600500);
    expect(parseMirrorTimestampMs("1727457600.123456789")).toBe(1727457600123);
    expect(parseMirrorTimestampMs("1727457600.1")).toBe(1727457600100);
    expect(parseMirrorTimestampMs("1727457600")).toBe(1727457600000);
  });

  it("returns NaN for malformed input", () => {
    expect(parseMirrorTimestampMs("not-a-time")).toBeNaN();
    expect(parseMirrorTimestampMs("0.0")).toBeNaN();
    expect(parseMirrorTimestampMs("")).toBeNaN();
  });
});

describe("vision feed helpers", () => {
  it("parseBlockAnatomy reads number, tx count, and hash", async () => {
    const { parseBlockAnatomy } = await import("./network-pulse");
    expect(
      parseBlockAnatomy({
        blocks: [
          {
            number: 100493825,
            count: 6,
            hash: "0xa37f5d71abebed339bdeda3207f7f9197823d3867731cd364696c94334cf8d99ad25f896dfc835400d7e98e40f99bcda",
          },
        ],
      }),
    ).toEqual({
      number: 100493825,
      txCount: 6,
      hash: "0xa37f5d71abebed339bdeda3207f7f9197823d3867731cd364696c94334cf8d99ad25f896dfc835400d7e98e40f99bcda",
    });
  });

  it("parseBlockAnatomy rejects malformed blocks", async () => {
    const { parseBlockAnatomy } = await import("./network-pulse");
    expect(parseBlockAnatomy({ blocks: [] })).toBeNull();
    expect(parseBlockAnatomy({ blocks: [{ number: 1 }] })).toBeNull();
    expect(parseBlockAnatomy({ blocks: [{ number: 1, count: -2, hash: "0x1" }] })).toBeNull();
    expect(parseBlockAnatomy(null)).toBeNull();
  });

  it("hbarPriceUsd reads the exchange rate", async () => {
    const { hbarPriceUsd } = await import("./network-pulse");
    expect(
      hbarPriceUsd({
        current_rate: { cent_equivalent: 354176, hbar_equivalent: 30000 },
      }),
    ).toBeCloseTo(0.11806, 5);
    expect(hbarPriceUsd({})).toBeNull();
    expect(hbarPriceUsd({ current_rate: { cent_equivalent: 1, hbar_equivalent: 0 } })).toBeNull();
    expect(hbarPriceUsd(null)).toBeNull();
  });

  it("parseNodeCity takes the part after the pipe", async () => {
    const { parseNodeCity } = await import("./network-pulse");
    expect(parseNodeCity("Hosted by LG | Singapore")).toBe("Singapore");
    expect(parseNodeCity("Hosted by Swirlds | Iowa, USA")).toBe("Iowa, USA");
    expect(parseNodeCity("no pipe here")).toBe("no pipe here");
    expect(parseNodeCity("")).toBeNull();
    expect(parseNodeCity(null)).toBeNull();
  });

  it("findWhaleLegs keeps only legs above the threshold", async () => {
    const { findWhaleLegs, WHALE_THRESHOLD_TINYBAR } = await import("./network-pulse");
    expect(WHALE_THRESHOLD_TINYBAR).toBe(1e13);
    const legs = findWhaleLegs([
      { account: "0.0.1", amount: 226 * 1e8 },
      { account: "0.0.2", amount: 250_000 * 1e8 },
      { account: "0.0.3", amount: -1_500_000 * 1e8 },
      { account: "0.0.4", amount: "big" },
    ]);
    expect(legs).toEqual([
      { account: "0.0.2", amount: 250_000 * 1e8 },
      { account: "0.0.3", amount: -1_500_000 * 1e8 },
    ]);
    expect(findWhaleLegs(undefined)).toEqual([]);
    expect(findWhaleLegs("nope")).toEqual([]);
  });

  it("decodePurchaseAmountHbar reads the amount word", async () => {
    const { decodePurchaseAmountHbar } = await import("./network-pulse");
    // offset=0x60, amount=250 HBAR in tinybar, fee=5 HBAR in tinybar
    const amountTiny = (250n * 100_000_000n).toString(16).padStart(64, "0");
    const feeTiny = (5n * 100_000_000n).toString(16).padStart(64, "0");
    const data = "0x" + "60".padStart(64, "0") + amountTiny + feeTiny + "00".padEnd(64, "0");
    expect(decodePurchaseAmountHbar(data)).toBe(250);
    expect(decodePurchaseAmountHbar("0x1234")).toBeNull();
    expect(decodePurchaseAmountHbar("not hex")).toBeNull();
    expect(decodePurchaseAmountHbar(null)).toBeNull();
  });

  it("formatFeedAgo and shortHash behave", async () => {
    const { formatFeedAgo, shortHash } = await import("./network-pulse");
    expect(formatFeedAgo(1_000_000, 1_180_000)).toBe("3m ago");
    expect(formatFeedAgo(2_000_000, 1_000_000)).toBe("0s ago");
    expect(shortHash("0xa37f5d71abebed339bdeda3207f7f9197823d3867731cd364696c94334cf8d99ad25f896dfc835400d7e98e40f99bcda")).toBe(
      "0xa37f…bcda",
    );
  });
});
