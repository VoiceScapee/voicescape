/**
 * Tests for contract address resolution guards.
 *
 * Regression test for the 2026-09-12 production bug: NEXT_PUBLIC_TIPS_ADDRESS
 * was left as the 0x000...000 placeholder from .env.example, so tip
 * transactions were built against ContractId 0.0.0 (shown as "Contract ID:
 * 0.0.0" in HashPack). Users paid gas but no tip — and no 2% fee — ever
 * reached the Tips contract.
 *
 * Two layers of defense:
 *  1. get*Address() never throws — safe during Next.js build/static
 *     generation. Reads degrade gracefully (resolvePage returns null).
 *  2. require*Address() throws at RUNTIME when a write is attempted with a
 *     missing/placeholder address, and hederaContractId() (lib/tx.ts)
 *     refuses the zero address at transaction-construction time.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getRegistryAddress,
  getTipsAddress,
  requireRegistryAddress,
  requireTipsAddress,
  resolvePage,
} from "./contracts";

const REAL_TIPS_EVM = "0x571D6d0C5D5ee7Fc1e47283Ad864305b7f7A88e0";
const REAL_REGISTRY_EVM = "0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58";
const ZERO = "0x0000000000000000000000000000000000000000";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getTipsAddress (build-safe, never throws)", () => {
  it("returns the zero placeholder as-is instead of throwing (write paths validate later)", () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", ZERO);
    expect(getTipsAddress()).toBe(ZERO);
  });

  it("falls back to the mainnet Tips address when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", "");
    expect(getTipsAddress()).toBe(REAL_TIPS_EVM);
  });

  it("returns the real EVM address unchanged", () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", REAL_TIPS_EVM);
    expect(getTipsAddress()).toBe(REAL_TIPS_EVM);
  });

  it("converts the known Hedera ID 0.0.10854060 to the EVM address", () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", "0.0.10854060");
    expect(getTipsAddress()).toBe(REAL_TIPS_EVM);
  });

  it("returns undefined for an unknown Hedera ID", () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", "0.0.12345");
    expect(getTipsAddress()).toBeUndefined();
  });
});

describe("requireTipsAddress (runtime write guard)", () => {
  it("throws a user-friendly error on the zero-address placeholder", () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", ZERO);
    expect(() => requireTipsAddress()).toThrow(/temporarily unavailable/i);
  });

  it("uses the mainnet fallback when unset (no throw)", () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", "");
    expect(requireTipsAddress()).toBe(REAL_TIPS_EVM);
  });

  it("returns the real EVM address", () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", REAL_TIPS_EVM);
    expect(requireTipsAddress()).toBe(REAL_TIPS_EVM);
  });

  it("converts the known Hedera ID 0.0.10854060 to the EVM address", () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", "0.0.10854060");
    expect(requireTipsAddress()).toBe(REAL_TIPS_EVM);
  });
});

describe("getRegistryAddress (build-safe, never throws)", () => {
  it("returns the zero placeholder as-is instead of throwing", () => {
    vi.stubEnv("NEXT_PUBLIC_REGISTRY_ADDRESS", ZERO);
    expect(getRegistryAddress()).toBe(ZERO);
  });

  it("falls back to the mainnet Registry address when unset", () => {
    vi.stubEnv("NEXT_PUBLIC_REGISTRY_ADDRESS", "");
    expect(getRegistryAddress()).toBe(REAL_REGISTRY_EVM);
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

describe("requireRegistryAddress (runtime write guard)", () => {
  it("throws a user-friendly error on the zero-address placeholder", () => {
    vi.stubEnv("NEXT_PUBLIC_REGISTRY_ADDRESS", ZERO);
    expect(() => requireRegistryAddress()).toThrow(/temporarily unavailable/i);
  });

  it("uses the mainnet fallback when unset (no throw)", () => {
    vi.stubEnv("NEXT_PUBLIC_REGISTRY_ADDRESS", "");
    expect(requireRegistryAddress()).toBe(REAL_REGISTRY_EVM);
  });

  it("returns the real EVM address", () => {
    vi.stubEnv("NEXT_PUBLIC_REGISTRY_ADDRESS", REAL_REGISTRY_EVM);
    expect(requireRegistryAddress()).toBe(REAL_REGISTRY_EVM);
  });

  it("converts the known Hedera ID 0.0.10854058 to the EVM address", () => {
    vi.stubEnv("NEXT_PUBLIC_REGISTRY_ADDRESS", "0.0.10854058");
    expect(requireRegistryAddress()).toBe(REAL_REGISTRY_EVM);
  });
});

describe("resolvePage (read path degrades gracefully)", () => {
  it("uses the mainnet Registry fallback when unset (build-safe)", async () => {
    vi.stubEnv("NEXT_PUBLIC_REGISTRY_ADDRESS", "");
    // With the mainnet fallback, resolvePage now attempts a read instead of
    // returning null. The read itself needs a chain/RPC — this test just
    // verifies getRegistryAddress returns the fallback.
    expect(getRegistryAddress()).toBe(REAL_REGISTRY_EVM);
  });
});
