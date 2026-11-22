/**
 * Tests for the session-identity root fix (2026-11-22): a session carries
 * the wallet's EVM address, which for ECDSA-keyed wallets (HashPack's
 * default) is the ALIAS, not the long-zero form. The old code ran
 * BigInt() over any 40 hex chars, turning an alias into a bogus
 * "0.0.<astronomical>" that matched no real account — ECDSA agents saw
 * empty dashboards/inboxes. sessionAddressToAccountId must derive
 * long-zero locally and resolve aliases via the mirror node, failing
 * closed (null) when the alias cannot be resolved.
 */
import { describe, expect, it, vi } from "vitest";
import { sessionAddressToAccountId } from "./agent-session";

// Danny's liaison wallet: ECDSA-keyed, alias EVM address on mainnet.
const DANNY_ALIAS = "0x4fb76eaa5eb6152501e99ca385c21d3dedf4ccca";
const DANNY_ACCOUNT = "0.0.10857765";
// Long-zero form of 0.0.12345 (0x3039 = 12345).
const LONG_ZERO_12345 = "0x0000000000000000000000000000000000003039";

function mirrorFetch(account: string | null, ok = true) {
  return vi.fn(async () => ({
    ok,
    json: async () => (account === null ? {} : { account }),
  }));
}

function asFetch(mock: ReturnType<typeof vi.fn>): typeof fetch {
  return mock as unknown as typeof fetch;
}

describe("sessionAddressToAccountId", () => {
  it("derives a long-zero address locally without touching the mirror", async () => {
    const fetchMock = mirrorFetch(DANNY_ACCOUNT);
    const id = await sessionAddressToAccountId(LONG_ZERO_12345, asFetch(fetchMock));
    expect(id).toBe("0.0.12345");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves an ECDSA alias to its real account via the mirror node", async () => {
    let seenUrl = "";
    const fetchMock = vi.fn(async (input: unknown) => {
      seenUrl = String(input);
      return { ok: true, json: async () => ({ account: DANNY_ACCOUNT }) };
    });
    const id = await sessionAddressToAccountId(DANNY_ALIAS, asFetch(fetchMock));
    expect(id).toBe(DANNY_ACCOUNT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seenUrl).toContain(`/api/v1/accounts/${DANNY_ALIAS}`);
  });

  it("returns null (fail closed) when the mirror cannot resolve the alias", async () => {
    const notFound = vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    }));
    expect(await sessionAddressToAccountId(DANNY_ALIAS, asFetch(notFound))).toBeNull();

    const throwing = vi.fn(async () => {
      throw new Error("mirror down");
    });
    expect(await sessionAddressToAccountId(DANNY_ALIAS, asFetch(throwing))).toBeNull();
  });

  it("returns null for a malformed mirror response", async () => {
    const fetchMock = mirrorFetch(null);
    expect(await sessionAddressToAccountId(DANNY_ALIAS, asFetch(fetchMock))).toBeNull();
  });

  it("returns null for non-EVM-address input", async () => {
    const fetchMock = mirrorFetch(DANNY_ACCOUNT);
    expect(await sessionAddressToAccountId("not-an-address", asFetch(fetchMock))).toBeNull();
    expect(await sessionAddressToAccountId("0.0.10857765", asFetch(fetchMock))).toBeNull();
    expect(await sessionAddressToAccountId("", asFetch(fetchMock))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
