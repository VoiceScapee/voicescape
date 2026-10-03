import { describe, expect, it } from "vitest";
import {
  decidePairingChannel,
  detectHashPackInAppBrowser,
  detectInjectedHederaWallet,
  friendlyWalletError,
  IN_APP_HANDSHAKE_FAILED_COPY,
  IN_APP_MODAL_BLOCKED_COPY,
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

describe("detectHashPackInAppBrowser — redundant in-app signals", () => {
  const androidChromeUA =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
  const desktopUA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  it("detects window.hashpack injection", () => {
    expect(
      detectHashPackInAppBrowser({
        hasInjectedHashpack: true,
        userAgent: desktopUA,
      }),
    ).toBe(true);
  });

  it("detects a hashpack user agent", () => {
    expect(
      detectHashPackInAppBrowser({
        hasInjectedHashpack: false,
        userAgent: "Mozilla/5.0 HashPack/1.2.3",
      }),
    ).toBe(true);
  });

  it("treats iframed-on-mobile as in-app (HashPack Android dApp browser iframes with no injection and no UA signal)", () => {
    expect(
      detectHashPackInAppBrowser({
        hasInjectedHashpack: false,
        userAgent: androidChromeUA,
        isIframed: true,
        isMobile: true,
      }),
    ).toBe(true);
  });

  it("does NOT treat an iframed desktop page as in-app (embeds are not wallets)", () => {
    expect(
      detectHashPackInAppBrowser({
        hasInjectedHashpack: false,
        userAgent: desktopUA,
        isIframed: true,
        isMobile: false,
      }),
    ).toBe(false);
  });

  it("is false for a plain external mobile browser (deep-link modal path stays intact)", () => {
    expect(
      detectHashPackInAppBrowser({
        hasInjectedHashpack: false,
        userAgent: androidChromeUA,
        isIframed: false,
        isMobile: true,
      }),
    ).toBe(false);
  });

  it("is false for a plain desktop browser", () => {
    expect(
      detectHashPackInAppBrowser({
        hasInjectedHashpack: false,
        userAgent: desktopUA,
      }),
    ).toBe(false);
  });
});

describe("decidePairingChannel — never the modal inside a wallet app", () => {
  it("routes to the iframe channel when the library discovered an iframe extension at init", () => {
    expect(
      decidePairingChannel({ iframeDiscoveredAtInit: true, inAppDetected: false }),
    ).toBe("iframe");
  });

  it("routes to the iframe channel when any in-app signal fired", () => {
    expect(
      decidePairingChannel({ iframeDiscoveredAtInit: false, inAppDetected: true }),
    ).toBe("iframe");
  });

  it("routes to the iframe channel when both fired", () => {
    expect(
      decidePairingChannel({ iframeDiscoveredAtInit: true, inAppDetected: true }),
    ).toBe("iframe");
  });

  it("routes to the modal ONLY when nothing in-app was detected (desktop / external mobile browser)", () => {
    expect(
      decidePairingChannel({ iframeDiscoveredAtInit: false, inAppDetected: false }),
    ).toBe("modal");
  });
});

describe("in-app pairing failure copy — plain words, actionable", () => {
  it("handshake failure tells the user to reopen from the dApp browser or use a regular browser", () => {
    expect(IN_APP_HANDSHAKE_FAILED_COPY).toMatch(/dApp browser/i);
    expect(IN_APP_HANDSHAKE_FAILED_COPY).toMatch(/regular browser/i);
    expect(IN_APP_HANDSHAKE_FAILED_COPY).toMatch(/WalletConnect/i);
  });

  it("modal-blocked copy explains why the pairing screen can't open in-app", () => {
    expect(IN_APP_MODAL_BLOCKED_COPY).toMatch(/built-in browser/i);
    expect(IN_APP_MODAL_BLOCKED_COPY).toMatch(/dApp browser/i);
  });
});
