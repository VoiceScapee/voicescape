/**
 * Tests for hederaContractId — the EVM-address to ContractId conversion used
 * for every wallet-signed contract call.
 *
 * Regression test for the 2026-09-12 production bug: a zero-address placeholder
 * produced ContractId 0.0.0 ("Contract ID: 0.0.0" in HashPack), burning user
 * gas on no-op transactions. This must throw instead.
 */
import { describe, it, expect } from "vitest";
import { hederaContractId } from "./tx";

const REAL_TIPS_EVM = "0x571D6d0C5D5ee7Fc1e47283Ad864305b7f7A88e0";
const ZERO = "0x0000000000000000000000000000000000000000";

describe("hederaContractId", () => {
  it("throws on the zero address instead of producing ContractId 0.0.0", () => {
    expect(() => hederaContractId(ZERO)).toThrow(/zero address/i);
  });

  it("throws on malformed addresses", () => {
    expect(() => hederaContractId("0.0.10854060")).toThrow(/invalid contract address/i);
    expect(() => hederaContractId("not-an-address")).toThrow(/invalid contract address/i);
    expect(() => hederaContractId("0x1234")).toThrow(/invalid contract address/i);
  });

  it("converts a real EVM address to a non-zero ContractId", () => {
    const cid = hederaContractId(REAL_TIPS_EVM);
    // Must NOT be 0.0.0 — the string form includes the EVM address suffix
    expect(cid.toString()).not.toMatch(/^0\.0\.0+$/);
    expect(cid.toString()).toContain("571d6d0c5d5ee7fc1e47283ad864305b7f7a88e0");
  });
});
