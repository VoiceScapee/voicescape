/**
 * Tests for the dual-form page-owner identity check.
 *
 * Regression test for the 2026-09-14 bug: the on-chain Registry stores the
 * owner's ECDSA-derived alias address (0x30c63dc4… for 0.0.10424063) while
 * sessions carry the long-zero 0x form — a direct string compare 403'd the
 * legitimate page owner on /api/analytics and /api/goals.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { isPageOwner } from "./owner-check";

const ALIAS = "0x30c63dc43608b6764a6b8b53960553aebf306817"; // 0.0.10424063's ECDSA alias
const LONG_ZERO = "0x00000000000000000000000000000000009f0eff"; // 0.0.10424063 long-zero

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isPageOwner", () => {
  it("matches identical addresses directly (no network)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await isPageOwner(ALIAS, ALIAS)).toBe(true);
    expect(await isPageOwner(ALIAS.toUpperCase(), ALIAS)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves the ECDSA alias via mirror node for long-zero sessions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ evm_address: ALIAS }),
      }),
    );
    // Registry holds alias, session holds long-zero → same account.
    expect(await isPageOwner(ALIAS, LONG_ZERO)).toBe(true);
  });

  it("rejects a different account's alias", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ evm_address: ALIAS }),
      }),
    );
    expect(
      await isPageOwner("0x1111111111111111111111111111111111111111", LONG_ZERO),
    ).toBe(false);
  });

  it("fails closed when the mirror node is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    expect(await isPageOwner(ALIAS, LONG_ZERO)).toBe(false);
  });

  it("fails closed on non-long-zero session addresses", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // Alias-form session address that doesn't match → no long-zero to resolve.
    expect(
      await isPageOwner(ALIAS, "0x2222222222222222222222222222222222222222"),
    ).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects empty inputs", async () => {
    expect(await isPageOwner("", LONG_ZERO)).toBe(false);
    expect(await isPageOwner(ALIAS, "")).toBe(false);
  });
});
