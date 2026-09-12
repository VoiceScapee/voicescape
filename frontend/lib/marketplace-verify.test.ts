import { describe, it, expect, vi, afterEach } from "vitest";
import {
  checkPayoutBelongsToOwner,
  evmAddressToAccountId,
  isBuyBlocked,
  mirrorBaseFor,
} from "./marketplace-verify";
import { longZeroToAccountId } from "./session-message";

const MAINNET = mirrorBaseFor("hedera-mainnet");

// The exact mainnet case from the 2026-09-12 field report: Brandon's test
// listing recorded the payout in long-zero form while his page registration
// holds the ECDSA alias form — both are account 0.0.10424063.
const PAYOUT_LONG_ZERO = "0x00000000000000000000000000000000009f0eff";
// Synthetic alias-form address (same shape as a real ECDSA alias).
const OWNER_ALIAS = "0x30c63dc43608b6764a111111111111111111111111";

function mockAccounts(map: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    async (url: unknown) => {
      const u = String(url);
      const addr = decodeURIComponent(u.split("/accounts/")[1] ?? "").toLowerCase();
      const account = map[addr];
      if (!account) return { ok: false };
      return { ok: true, json: async () => ({ account }) };
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mirrorBaseFor", () => {
  it("picks mainnet vs testnet", () => {
    expect(mirrorBaseFor("hedera-mainnet")).toContain("mainnet.mirrornode.hedera.com");
    expect(mirrorBaseFor("hedera-testnet")).toContain("testnet.mirrornode.hedera.com");
  });
});

describe("longZeroToAccountId", () => {
  it("derives 0.0.10424063 from its long-zero form", () => {
    expect(longZeroToAccountId(PAYOUT_LONG_ZERO)).toBe("0.0.10424063");
  });

  it("derives account zero", () => {
    expect(longZeroToAccountId("0x0000000000000000000000000000000000000000")).toBe("0.0.0");
  });

  it("returns null for the alias (ECDSA) form", () => {
    expect(longZeroToAccountId(OWNER_ALIAS)).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(longZeroToAccountId("not-an-address")).toBeNull();
    expect(longZeroToAccountId("0x1234")).toBeNull();
    expect(longZeroToAccountId("0.0.10424063")).toBeNull();
  });
});

describe("evmAddressToAccountId", () => {
  it("derives a long-zero address locally with ZERO network calls", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await evmAddressToAccountId(PAYOUT_LONG_ZERO, MAINNET)).toBe("0.0.10424063");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes 0.0.x through untouched", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await evmAddressToAccountId("0.0.10424063", MAINNET)).toBe("0.0.10424063");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves an alias-form address via the mirror node", async () => {
    mockAccounts({ [OWNER_ALIAS]: "0.0.10424063" });
    expect(await evmAddressToAccountId(OWNER_ALIAS, MAINNET)).toBe("0.0.10424063");
  });

  it("returns null when the mirror node cannot resolve an alias", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false }));
    expect(await evmAddressToAccountId(OWNER_ALIAS, MAINNET)).toBeNull();
  });

  it("returns null on network failure instead of throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    expect(await evmAddressToAccountId(OWNER_ALIAS, MAINNET)).toBeNull();
  });
});

describe("checkPayoutBelongsToOwner", () => {
  it("matches identical strings with zero network calls", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await checkPayoutBelongsToOwner(PAYOUT_LONG_ZERO, PAYOUT_LONG_ZERO, MAINNET)).toBe(
      "match",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("matches case-insensitively on the fast path", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(
      await checkPayoutBelongsToOwner(PAYOUT_LONG_ZERO, PAYOUT_LONG_ZERO.toUpperCase(), MAINNET),
    ).toBe("match");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("matches a long-zero payout to the alias-form owner of the SAME account", async () => {
    // The long-zero side derives locally now — only the alias needs the mock.
    mockAccounts({ [OWNER_ALIAS]: "0.0.10424063" });
    expect(await checkPayoutBelongsToOwner(PAYOUT_LONG_ZERO, OWNER_ALIAS, MAINNET)).toBe("match");
  });

  it("flags mismatch when payout and owner belong to DIFFERENT accounts", async () => {
    mockAccounts({ [OWNER_ALIAS]: "0.0.99999999" });
    expect(await checkPayoutBelongsToOwner(PAYOUT_LONG_ZERO, OWNER_ALIAS, MAINNET)).toBe(
      "mismatch",
    );
  });

  it("returns unknown (not mismatch) when the mirror node is unreachable", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false }));
    expect(await checkPayoutBelongsToOwner(PAYOUT_LONG_ZERO, OWNER_ALIAS, MAINNET)).toBe(
      "unknown",
    );
  });
});

describe("isBuyBlocked", () => {
  it("blocks on a proven mismatch", () => {
    expect(isBuyBlocked("mismatch")).toBe(true);
  });

  it("blocks while the check is still running", () => {
    expect(isBuyBlocked("checking")).toBe(true);
  });

  it("does not block on match, idle, or unknown", () => {
    expect(isBuyBlocked("match")).toBe(false);
    expect(isBuyBlocked("idle")).toBe(false);
    expect(isBuyBlocked("unknown")).toBe(false);
  });
});
