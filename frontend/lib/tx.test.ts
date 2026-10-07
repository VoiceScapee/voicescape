/**
 * Tests for hederaContractId — the EVM-address to ContractId conversion used
 * for every wallet-signed contract call.
 *
 * Regression test for the 2026-09-12 production bug: a zero-address placeholder
 * produced ContractId 0.0.0 ("Contract ID: 0.0.0" in HashPack), burning user
 * gas on no-op transactions. This must throw instead.
 */
import { describe, it, expect, vi } from "vitest";
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

describe("mirrorContractCall revert vs unreachable", () => {
  // Regression test (2026-10-07): the L1 "honest mirror errors" fix must
  // distinguish a contract REVERT (name not registered — callers map it to
  // null / registered:false) from a TRANSPORT failure (couldn't reach
  // Hedera). Collapsing both into MirrorUnreachable broke Buddy's
  // lookupBlockpage and viewResolve's not-registered path.
  const chain = { id: "mainnet" } as never;

  async function callWith(fetchImpl: unknown) {
    const { mirrorContractCall, MirrorUnreachable } = await import("./tx");
    vi.stubGlobal("fetch", fetchImpl);
    try {
      return await mirrorContractCall(chain, "0xabc", "0x1234").then(
        (r: string) => ({ ok: true as const, value: r }),
        (e: unknown) => ({
          ok: false as const,
          unreachable: e instanceof MirrorUnreachable,
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("surfaces a revert's detail as a plain Error, not MirrorUnreachable", async () => {
    const res = await callWith(async () =>
      new Response(
        JSON.stringify({
          _status: {
            messages: [{ message: "CONTRACT_REVERT_EXECUTED" }],
          },
        }),
        { status: 400 },
      ),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.unreachable).toBe(false);
      expect(res.message).toMatch(/revert/i);
      expect(res.message).toContain("CONTRACT_REVERT_EXECUTED");
    }
  });

  it("maps a genuine transport/server failure to MirrorUnreachable", async () => {
    const res = await callWith(
      async () => new Response("bad gateway", { status: 502 }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.unreachable).toBe(true);
  });

  it("maps a network throw to MirrorUnreachable", async () => {
    const res = await callWith(async () => {
      throw new TypeError("fetch failed");
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.unreachable).toBe(true);
  });
});
