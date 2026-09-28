import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChainlinkHbarUsdPrice } from "./x402";

/**
 * Chainlink HBAR/USD feed reader — validation must fail closed.
 * Synthetic latestRoundData() payloads: (roundId, answer, startedAt,
 * updatedAt, answeredInRound), 8-decimal answer.
 */
function payload(roundId: bigint, answer: bigint, updatedAt: bigint, answeredInRound: bigint) {
  const w = (v: bigint) => v.toString(16).padStart(64, "0");
  const neg = answer < 0n ? (1n << 256n) + answer : answer; // two's complement
  return (
    "0x" +
    w(roundId) +
    w(neg) +
    w(1_790_634_000n) +
    w(updatedAt) +
    w(answeredInRound)
  );
}

const NOW_S = Math.floor(Date.now() / 1000);

function stubFetch(resultHex: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ json: async () => ({ result: resultHex }) })),
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getChainlinkHbarUsdPrice", () => {
  it("decodes a live round to USD (8 decimals)", async () => {
    // Real mainnet shape captured 2026-09-28: answer 12288046 -> $0.12288046
    stubFetch(payload(7n, 12_288_046n, BigInt(NOW_S - 360), 7n));
    await expect(getChainlinkHbarUsdPrice()).resolves.toBeCloseTo(0.12288046, 8);
  });

  it("returns null on an incomplete round", async () => {
    stubFetch(payload(8n, 12_288_046n, BigInt(NOW_S - 60), 7n));
    await expect(getChainlinkHbarUsdPrice()).resolves.toBeNull();
  });

  it("returns null when the round is stale (>24h)", async () => {
    stubFetch(payload(7n, 12_288_046n, BigInt(NOW_S - 25 * 3600), 7n));
    await expect(getChainlinkHbarUsdPrice()).resolves.toBeNull();
  });

  it("returns null on a non-positive answer", async () => {
    stubFetch(payload(7n, 0n, BigInt(NOW_S - 60), 7n));
    await expect(getChainlinkHbarUsdPrice()).resolves.toBeNull();
  });

  it("returns null on a negative (two's complement) answer", async () => {
    stubFetch(payload(7n, -5n, BigInt(NOW_S - 60), 7n));
    await expect(getChainlinkHbarUsdPrice()).resolves.toBeNull();
  });

  it("returns null when the call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    await expect(getChainlinkHbarUsdPrice()).resolves.toBeNull();
  });

  it("returns null on a malformed result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({}) })));
    await expect(getChainlinkHbarUsdPrice()).resolves.toBeNull();
  });
});
