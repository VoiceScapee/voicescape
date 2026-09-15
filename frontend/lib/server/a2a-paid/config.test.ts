/**
 * Mainnet-guard + config tests for the Phase 5 paid endpoint prototype.
 */
import { describe, expect, it } from "vitest";
import {
  assertTestnetMirror,
  getPaidConfig,
  isAccountIdForm,
  normalizeToAccountId,
  TESTNET_MIRROR_BASE,
  TIP_PAGE_SELECTOR,
} from "./config";

const TESTNET_ID = "0.0.12345";

describe("getPaidConfig", () => {
  it("accepts a testnet 0.0.x tips id", () => {
    const cfg = getPaidConfig({ A2A_TESTNET_TIPS_ID: TESTNET_ID });
    expect(cfg.tipsAccountId).toBe(TESTNET_ID);
    expect(cfg.mirrorBase).toBe(TESTNET_MIRROR_BASE);
  });

  it("fails closed when the env var is missing", () => {
    expect(() => getPaidConfig({})).toThrow(/misconfigured/);
  });

  it("refuses the mainnet Tips contract id", () => {
    expect(() => getPaidConfig({ A2A_TESTNET_TIPS_ID: "0.0.10854060" })).toThrow(
      /mainnet_forbidden/,
    );
  });

  it("refuses the mainnet Tips EVM address", () => {
    expect(() =>
      getPaidConfig({
        A2A_TESTNET_TIPS_ID: "0x571D6d0C5D5ee7Fc1e47283Ad864305b7f7A88e0",
      }),
    ).toThrow(/misconfigured|mainnet_forbidden/);
  });

  it("rejects non-0.0.x forms", () => {
    expect(() =>
      getPaidConfig({ A2A_TESTNET_TIPS_ID: "0x1234abcd" }),
    ).toThrow(/0\.0\.x/);
  });
});

describe("assertTestnetMirror", () => {
  it("accepts the testnet mirror base", () => {
    expect(() => assertTestnetMirror(TESTNET_MIRROR_BASE)).not.toThrow();
  });

  it("refuses any mainnet mirror URL", () => {
    expect(() =>
      assertTestnetMirror("https://mainnet.mirrornode.hedera.com/api/v1"),
    ).toThrow(/mainnet_forbidden/);
  });
});

describe("helpers", () => {
  it("validates 0.0.x account id form", () => {
    expect(isAccountIdForm("0.0.12345")).toBe(true);
    expect(isAccountIdForm("0.0.abc")).toBe(false);
    expect(isAccountIdForm("0x1234")).toBe(false);
  });

  it("normalizes the long-zero EVM `to` form to 0.0.x", () => {
    expect(normalizeToAccountId("0x0000000000000000000000000000000000003039")).toBe(
      "0.0.12345",
    );
    expect(normalizeToAccountId("0.0.12345")).toBe("0.0.12345");
  });

  it("uses the real tipPage selector", () => {
    // keccak256("tipPage(string)")[:4] — computed independently with ethers.
    expect(TIP_PAGE_SELECTOR).toBe("0x8b0de5cb");
  });
});
