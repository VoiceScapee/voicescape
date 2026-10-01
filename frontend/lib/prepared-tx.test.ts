/**
 * prepared-tx unit tests: the pure helpers (tx-id forms, HashScan links,
 * account normalization) and the distinct error classes the one-tap card
 * and the /agents/claim fallback switch on.
 */
import { describe, expect, it } from "vitest";
import {
  toMirrorTxId,
  hashscanTxUrl,
  normalizeAccountId,
  NoWalletPairingError,
  StaleWalletPairingError,
  OwnerMismatchError,
} from "./prepared-tx";

describe("toMirrorTxId", () => {
  it("converts the @ form to the mirror - form", () => {
    expect(toMirrorTxId("0.0.123@1700000000.000000001")).toBe(
      "0.0.123-1700000000-000000001",
    );
  });
  it("passes malformed ids through untouched", () => {
    expect(toMirrorTxId("not-a-tx-id")).toBe("not-a-tx-id");
    expect(toMirrorTxId("")).toBe("");
  });
});

describe("hashscanTxUrl", () => {
  it("builds a mainnet HashScan transaction link", () => {
    expect(hashscanTxUrl("0.0.123@1700000000.000000001")).toBe(
      "https://hashscan.io/mainnet/transaction/0.0.123-1700000000-000000001",
    );
  });
});

describe("normalizeAccountId", () => {
  it("maps 0.0.x and its 0x… EVM form to one string", () => {
    const fromShort = normalizeAccountId("0.0.123");
    const fromEvm = normalizeAccountId("0x000000000000000000000000000000000000007b");
    expect(fromShort).toBe(fromEvm);
  });
  it("is case-insensitive for EVM addresses", () => {
    expect(normalizeAccountId("0xABCDEF1234567890ABCDEF1234567890ABCDEF12")).toBe(
      normalizeAccountId("0xabcdef1234567890abcdef1234567890abcdef12"),
    );
  });
});

describe("error classes", () => {
  it("are distinct Errors the UI can switch on", () => {
    const noPairing = new NoWalletPairingError("nope");
    const stale = new StaleWalletPairingError("stale");
    const mismatch = new OwnerMismatchError("wrong");
    for (const e of [noPairing, stale, mismatch]) expect(e).toBeInstanceOf(Error);
    expect(noPairing).toBeInstanceOf(NoWalletPairingError);
    expect(noPairing).not.toBeInstanceOf(StaleWalletPairingError);
    expect(stale).toBeInstanceOf(StaleWalletPairingError);
    expect(stale).not.toBeInstanceOf(OwnerMismatchError);
    expect(mismatch).toBeInstanceOf(OwnerMismatchError);
    expect(mismatch).not.toBeInstanceOf(NoWalletPairingError);
  });
});
