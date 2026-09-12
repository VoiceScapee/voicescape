/**
 * Tests for contract address resolution guards.
 *
 * Regression test for the 2026-09-12 production bug: NEXT_PUBLIC_TIPS_ADDRESS
 * was left as the 0x000...000 placeholder from .env.example, so tip
 * transactions were built against ContractId 0.0.0 (shown as "Contract ID:
 * 0.0.0" in HashPack). Users paid gas but no tip — and no 2% fee — ever
 * reached the Tips contract. The app must now refuse to build such a
 * transaction instead of silently sending to the zero address.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { getRegistryAddress, getTipsAddress } from "./contracts";

const REAL_TIPS_EVM = "0x571D6d0C5D5ee7Fc1e47283Ad864305b7f7A88e0";
const REAL_REGISTRY_EVM = "0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58";
const ZERO = "0x0000000000000000000000000000000000000000";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getTipsAddress", () => {
  it("throws on the zero-address placeholder instead of returning 0x000...000", () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", ZERO);
    expect(() => getTipsAddress()).toThrow(/zero address/i);
  });

  it("throws when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", "");
    expect(() => getTipsAddress()).toThrow(/not set/i);
  });

  it("returns the real EVM address unchanged", () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", REAL_TIPS_EVM);
    expect(getTipsAddress()).toBe(REAL_TIPS_EVM);
  });

  it("converts the known Hedera ID 0.0.10854060 to the EVM address", () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", "0.0.10854060");
    expect(getTipsAddress()).toBe(REAL_TIPS_EVM);
  });
});

describe("getRegistryAddress", () => {
  it("throws on the zero-address placeholder instead of returning 0x000...000", () => {
    vi.stubEnv("NEXT_PUBLIC_REGISTRY_ADDRESS", ZERO);
    expect(() => getRegistryAddress()).toThrow(/zero address/i);
  });

  it("throws when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_REGISTRY_ADDRESS", "");
    expect(() => getRegistryAddress()).toThrow(/not set/i);
  });

  it("returns the real EVM address unchanged", () => {
    vi.stubEnv("NEXT_PUBLIC_REGISTRY_ADDRESS", REAL_REGISTRY_EVM);
    expect(getRegistryAddress()).toBe(REAL_REGISTRY_EVM);
  });

  it("converts the known Hedera ID 0.0.10854058 to the EVM address", () => {
    vi.stubEnv("NEXT_PUBLIC_REGISTRY_ADDRESS", "0.0.10854058");
    expect(getRegistryAddress()).toBe(REAL_REGISTRY_EVM);
  });
});
