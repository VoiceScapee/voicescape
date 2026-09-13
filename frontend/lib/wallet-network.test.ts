
/**
 * Tests for wallet network validation on pairing (lib/wallet.tsx).
 *
 * A wallet sitting on testnet must never pair as if it were on mainnet:
 * every subsequent transaction would be built for the wrong network.
 * accountIdFromSession throws a user-actionable error on mismatch.
 */
import { describe, expect, it } from "vitest";
import { accountIdFromSession, friendlyWalletError, networkFromChainKey } from "./wallet";

function sessionWith(account: string) {
  return { namespaces: { hedera: { accounts: [account] } } };
}

describe("networkFromChainKey", () => {
  it("maps chain keys to WalletConnect network names", () => {
    expect(networkFromChainKey("hedera-mainnet")).toBe("mainnet");
    expect(networkFromChainKey("hedera-testnet")).toBe("testnet");
  });
});

describe("accountIdFromSession network validation", () => {
  it("returns the account when the session network matches", () => {
    expect(accountIdFromSession(sessionWith("hedera:mainnet:0.0.12345"), "mainnet")).toBe(
      "0.0.12345",
    );
  });

  it("throws a user-actionable error on network mismatch", () => {
    expect(() => accountIdFromSession(sessionWith("hedera:testnet:0.0.12345"), "mainnet")).toThrow(
      /testnet.*mainnet|mainnet.*testnet/i,
    );
  });

  it("skips validation when no expected network is given", () => {
    expect(accountIdFromSession(sessionWith("hedera:testnet:0.0.12345"))).toBe("0.0.12345");
  });

  it("returns null when the session has no accounts", () => {
    expect(accountIdFromSession({ namespaces: {} }, "mainnet")).toBeNull();
  });
});

describe("friendlyWalletError Hedera precheck mapping", () => {
  it("maps INSUFFICIENT_PAYER_BALANCE to human copy", () => {
    expect(friendlyWalletError(new Error("9000: INSUFFICIENT_PAYER_BALANCE"))).toMatch(
      /not enough HBAR/i,
    );
  });

  it("maps user rejection variants to a declined message", () => {
    expect(friendlyWalletError(new Error("User rejected the request"))).toMatch(/declined/i);
    expect(friendlyWalletError(new Error("4001"))).toMatch(/declined/i);
  });

  it("maps TRANSACTION_EXPIRED to a retry message", () => {
    expect(friendlyWalletError(new Error("TRANSACTION_EXPIRED"))).toMatch(/expired.*try again/i);
  });

  it("passes unknown errors through unchanged", () => {
    expect(friendlyWalletError(new Error("weird custom failure"))).toBe("weird custom failure");
  });
});
