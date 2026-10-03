/**
 * HBAR price contract tests.
 *
 * getHbarUsdPrice() must return null (never a hardcoded guess) when every
 * price source fails — callers convert users' dollar intent at this price,
 * and a stale guess silently breaks that intent.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadX402() {
  const m = await import("./x402");
  return m as typeof import("./x402");
}

describe("getHbarUsdPrice", () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_HBAR_USD_PRICE;
  });

  it("returns null when every source fails — never a hardcoded guess", async () => {
    // Chainlink feed fails, CoinGecko fails.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const { getHbarUsdPrice } = await loadX402();
    // getChainlinkHbarUsdPrice does its own fetch internally; with fetch
    // stubbed to throw it resolves null, then CoinGecko throws too.
    const price = await getHbarUsdPrice();
    expect(price).toBeNull();
  });

  it("prefers the env override when set", async () => {
    process.env.NEXT_PUBLIC_HBAR_USD_PRICE = "0.31";
    const { getHbarUsdPrice } = await loadX402();
    await expect(getHbarUsdPrice()).resolves.toBe(0.31);
  });

  it("railUsdCents returns null for HBAR when the price is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const { railUsdCents } = await loadX402();
    const cents = await railUsdCents({ kind: "HBAR", amount: "100000000" } as never);
    expect(cents).toBeNull();
  });
});
