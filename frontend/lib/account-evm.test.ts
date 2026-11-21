/**
 * Tests for lib/account-evm.ts — ECDSA alias vs long-zero ownership.
 *
 * Live proof (2026-11-20): account 0.0.10857765 has mirror evm_address
 * 0x4fb76eaa5eb6152501e99ca385c21d3dedf4ccca and owns /danny with that
 * alias as the Registry owner; the long-zero form is 0x0000…a5ad25.
 * Any comparison that only knows the long-zero form reads this owner
 * as a stranger.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  fetchAccountEvmAddress,
  isSameOnchainOwner,
  clearAccountEvmCache,
} from "./account-evm";

const ALIAS = "0x4fb76eaa5eb6152501e99ca385c21d3dedf4ccca";
const LONG_ZERO = "0x0000000000000000000000000000000000a5ad25";

describe("isSameOnchainOwner", () => {
  it("matches an ECDSA owner by its alias address", () => {
    expect(isSameOnchainOwner(ALIAS, "0.0.10857765", ALIAS)).toBe(true);
  });

  it("matches an ED25519 owner by the long-zero form", () => {
    expect(isSameOnchainOwner(LONG_ZERO, "0.0.10857765", null)).toBe(true);
  });

  it("does NOT match an ECDSA owner on the long-zero form alone", () => {
    // This is the bug: without the alias, the real owner looks foreign.
    expect(isSameOnchainOwner(ALIAS, "0.0.10857765", null)).toBe(false);
  });

  it("matches identical 0x addresses regardless of case", () => {
    expect(isSameOnchainOwner(ALIAS.toUpperCase(), ALIAS, null)).toBe(true);
  });

  it("rejects a different owner and empty inputs", () => {
    expect(
      isSameOnchainOwner("0x0000000000000000000000000000000000000001", "0.0.10857765", ALIAS),
    ).toBe(false);
    expect(isSameOnchainOwner("", "0.0.10857765", ALIAS)).toBe(false);
    expect(isSameOnchainOwner(ALIAS, "", ALIAS)).toBe(false);
  });
});

describe("fetchAccountEvmAddress", () => {
  beforeEach(() => clearAccountEvmCache());

  it("returns the mirror evm_address (alias) for an account", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ account: "0.0.10857765", evm_address: ALIAS })),
    );
    await expect(fetchAccountEvmAddress("0.0.10857765", fetchFn as never)).resolves.toBe(ALIAS);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns null (fail-soft) when the mirror is unreachable", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(fetchAccountEvmAddress("0.0.10857765", fetchFn as never)).resolves.toBeNull();
  });

  it("returns null for a malformed account id without fetching", async () => {
    const fetchFn = vi.fn(async () => new Response("{}"));
    await expect(fetchAccountEvmAddress("not-an-account", fetchFn as never)).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("caches a successful lookup per account", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ account: "0.0.10857765", evm_address: ALIAS })),
    );
    await fetchAccountEvmAddress("0.0.10857765", fetchFn as never);
    await fetchAccountEvmAddress("0.0.10857765", fetchFn as never);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
