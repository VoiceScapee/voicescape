import { describe, expect, it } from "vitest";
import {
  detectInjectedHederaWallet,
  friendlyWalletError,
  isPairingCancelled,
  PairingCancelledError,
  shouldSuggestWalletInstall,
} from "./wallet";

describe("detectInjectedHederaWallet", () => {
  it("detects the HashPack extension injection", () => {
    expect(detectInjectedHederaWallet({ hashpack: {}, blade: undefined })).toBe(true);
  });

  it("detects the Blade extension injection", () => {
    expect(detectInjectedHederaWallet({ hashpack: undefined, blade: {} })).toBe(true);
  });

  it("is false with no injected provider", () => {
    expect(detectInjectedHederaWallet({})).toBe(false);
    expect(detectInjectedHederaWallet({ hashpack: null, blade: null })).toBe(false);
    expect(detectInjectedHederaWallet({ hashpack: undefined, blade: undefined })).toBe(false);
  });
});

describe("shouldSuggestWalletInstall — no dead-end modal", () => {
  it("suggests install on desktop with no wallet anywhere", () => {
    expect(
      shouldSuggestWalletInstall({
        isMobile: false,
        inHashPackBrowser: false,
        hasInjectedWallet: false,
      }),
    ).toBe(true);
  });

  it("does not suggest on mobile (the modal deep-links into the wallet app)", () => {
    expect(
      shouldSuggestWalletInstall({
        isMobile: true,
        inHashPackBrowser: false,
        hasInjectedWallet: false,
      }),
    ).toBe(false);
  });

  it("does not suggest inside a wallet's in-app browser", () => {
    expect(
      shouldSuggestWalletInstall({
        isMobile: false,
        inHashPackBrowser: true,
        hasInjectedWallet: false,
      }),
    ).toBe(false);
  });

  it("does not suggest when a wallet extension is injected", () => {
    expect(
      shouldSuggestWalletInstall({
        isMobile: false,
        inHashPackBrowser: false,
        hasInjectedWallet: true,
      }),
    ).toBe(false);
  });
});

describe("isPairingCancelled", () => {
  it("recognizes our PairingCancelledError", () => {
    expect(isPairingCancelled(new PairingCancelledError())).toBe(true);
  });

  it("recognizes the library's modal-close rejection", () => {
    expect(isPairingCancelled(new Error("User rejected pairing"))).toBe(true);
    expect(isPairingCancelled("User rejected pairing")).toBe(true);
  });

  it("is false for real failures and empty values", () => {
    expect(isPairingCancelled(new Error("boom"))).toBe(false);
    expect(isPairingCancelled(null)).toBe(false);
    expect(isPairingCancelled(undefined)).toBe(false);
  });
});

describe("friendlyWalletError — pairing cancel copy", () => {
  const calm =
    "Connection closed before your wallet approved it — try again when you're ready.";

  it("maps a dismissed pairing modal to calm copy, not a declined-transaction message", () => {
    expect(friendlyWalletError(new PairingCancelledError())).toBe(calm);
    expect(friendlyWalletError(new Error("User rejected pairing"))).toBe(calm);
  });
});
