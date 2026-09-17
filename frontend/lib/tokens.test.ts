import { describe, expect, it } from "vitest";
import { hbarToWei } from "./tokens";

describe("hbarToWei", () => {
  it("converts whole HBAR to wei", () => {
    expect(hbarToWei(1)).toBe(1_000_000_000_000_000_000n);
    expect(hbarToWei(5)).toBe(5_000_000_000_000_000_000n);
  });

  it("converts fractional HBAR (tinybar precision)", () => {
    // 0.1 HBAR = 10_000_000 tinybars = 1e17 wei
    expect(hbarToWei(0.1)).toBe(100_000_000_000_000_000n);
  });

  it("rejects non-positive amounts", () => {
    expect(() => hbarToWei(0)).toThrow("Invalid HBAR amount.");
    expect(() => hbarToWei(-2)).toThrow("Invalid HBAR amount.");
    expect(() => hbarToWei(NaN)).toThrow("Invalid HBAR amount.");
  });
});
