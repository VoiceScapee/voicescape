import { describe, expect, it } from "vitest";
import {
  formatTokenAmount,
  parseTokenAmount,
  tokenIdToEvmAddress,
  weiToHbar,
  SAUCER_ROUTER_ID,
  WHBAR_ID,
} from "./swap";

describe("tokenIdToEvmAddress", () => {
  it("derives the long-zero EVM address for the Saucerswap router", () => {
    // 0.0.3045981 = 0x2E7A5D
    expect(tokenIdToEvmAddress(SAUCER_ROUTER_ID)).toBe(
      "0x00000000000000000000000000000000002e7a5d",
    );
  });

  it("derives the long-zero EVM address for WHBAR", () => {
    // 0.0.1456986 = 0x163B5A
    expect(tokenIdToEvmAddress(WHBAR_ID)).toBe(
      "0x0000000000000000000000000000000000163b5a",
    );
  });

  it("handles mainnet USDC (0.0.456858)", () => {
    // 0.0.456858 = 0x6F89A
    expect(tokenIdToEvmAddress("0.0.456858")).toBe(
      "0x000000000000000000000000000000000006f89a",
    );
  });

  it("rejects non-Hedera ids", () => {
    expect(() => tokenIdToEvmAddress("0x1234")).toThrow();
    expect(() => tokenIdToEvmAddress("abc")).toThrow();
    expect(() => tokenIdToEvmAddress("")).toThrow();
  });
});

describe("parseTokenAmount", () => {
  it("parses whole and fractional amounts without float error", () => {
    expect(parseTokenAmount("1.5", 6)).toBe(1_500_000n);
    expect(parseTokenAmount("10", 6)).toBe(10_000_000n);
    expect(parseTokenAmount("0.000001", 6)).toBe(1n);
  });

  it("handles 8-decimal tokens", () => {
    expect(parseTokenAmount("1.23456789", 8)).toBe(123_456_789n);
  });

  it("rejects junk, zero, and over-precision input", () => {
    expect(parseTokenAmount("", 6)).toBeNull();
    expect(parseTokenAmount("abc", 6)).toBeNull();
    expect(parseTokenAmount("0", 6)).toBeNull();
    expect(parseTokenAmount("0.00", 6)).toBeNull();
    // 7 fractional digits on a 6-decimal token
    expect(parseTokenAmount("1.0000001", 6)).toBeNull();
  });

  it("strips currency symbols like the tip input does", () => {
    expect(parseTokenAmount("$5", 6)).toBe(5_000_000n);
  });
});

describe("formatTokenAmount", () => {
  it("formats smallest-unit balances for display", () => {
    expect(formatTokenAmount(1_500_000n, 6)).toBe("1.5");
    expect(formatTokenAmount(10_000_000n, 6)).toBe("10");
    expect(formatTokenAmount(1n, 6)).toBe("0.000001");
    expect(formatTokenAmount(0n, 6)).toBe("0");
  });
});

describe("weiToHbar", () => {
  it("converts 18-decimal wei to HBAR", () => {
    expect(weiToHbar(1_000_000_000_000_000_000n)).toBe(1);
    expect(weiToHbar(500_000_000_000_000_000n)).toBe(0.5);
  });
});
