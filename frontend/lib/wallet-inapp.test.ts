/**
 * Tests for HashPack in-app browser detection (lib/wallet.tsx).
 *
 * Background: HashPack's iOS in-app browser provides NEITHER of the
 * synchronous in-app signals (no `window.hashpack` injection, no
 * "hashpack" in the WKWebView user agent), so sync detection missed it
 * and the app fell back to the WalletConnect modal — which hangs on
 * iPhone ("Tap 'Open' to continue..."). The fix probes the iframe
 * postMessage channel (`hedera-iframe-query` → `hedera-iframe-response`),
 * the same platform-agnostic handshake DAppConnector uses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectHashPackInAppBrowser,
  IN_APP_PROBE_TIMEOUT_MS,
  isHashPackInAppBrowserAsync,
  isMobileUserAgent,
  probeInAppWallet,
} from "./wallet";

const IPHONE_WKWEBVIEW_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_HASHAPP_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 HashPack/2.1.0";
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

describe("detectHashPackInAppBrowser (pure sync signals)", () => {
  it("detects injected window.hashpack", () => {
    expect(
      detectHashPackInAppBrowser({ hasInjectedHashpack: true, userAgent: "" }),
    ).toBe(true);
  });

  it("detects 'hashpack' in the user agent (Android in-app browser)", () => {
    expect(
      detectHashPackInAppBrowser({
        hasInjectedHashpack: false,
        userAgent: ANDROID_HASHAPP_UA,
      }),
    ).toBe(true);
  });

  it("misses HashPack iOS in-app browser (no injection, no UA signal) — the bug", () => {
    // Documents the gap: a plain iOS WKWebView UA is indistinguishable
    // from Safari by sync signals alone.
    expect(
      detectHashPackInAppBrowser({
        hasInjectedHashpack: false,
        userAgent: IPHONE_WKWEBVIEW_UA,
      }),
    ).toBe(false);
  });

  it("returns false for desktop browsers", () => {
    expect(
      detectHashPackInAppBrowser({
        hasInjectedHashpack: false,
        userAgent: DESKTOP_CHROME_UA,
      }),
    ).toBe(false);
  });
});

describe("isMobileUserAgent", () => {
  it("matches iPhone, iPad, Android", () => {
    expect(isMobileUserAgent(IPHONE_WKWEBVIEW_UA)).toBe(true);
    expect(isMobileUserAgent(ANDROID_HASHAPP_UA)).toBe(true);
    expect(
      isMobileUserAgent(
        "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);
  });

  it("rejects desktop user agents", () => {
    expect(isMobileUserAgent(DESKTOP_CHROME_UA)).toBe(false);
    expect(isMobileUserAgent("")).toBe(false);
  });

  it("exposes the probe timeout used on mobile", () => {
    expect(IN_APP_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(IN_APP_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

type FakeWindow = {
  hashpack?: unknown;
  parent: { postMessage: (msg: unknown, target: string) => void };
  addEventListener: (type: string, cb: (e: { data: unknown }) => void) => void;
  removeEventListener: (type: string, cb: (e: { data: unknown }) => void) => void;
  emitMessage: (data: unknown) => void;
  listenerCount: () => number;
};

/** Minimal window stub with a controllable message bus. */
function stubWindow(opts: { hashpack?: unknown; answerProbe?: boolean } = {}): FakeWindow {
  const listeners = new Set<(e: { data: unknown }) => void>();
  const fake: FakeWindow = {
    hashpack: opts.hashpack,
    parent: {
      postMessage: () => {
        // Simulate the wallet's in-app container answering the query.
        if (opts.answerProbe) {
          queueMicrotask(() =>
            fake.emitMessage({
              type: "hedera-iframe-response",
              metadata: { name: "HashPack", id: "hashpack" },
            }),
          );
        }
      },
    },
    addEventListener: (_type, cb) => {
      listeners.add(cb);
    },
    removeEventListener: (_type, cb) => {
      listeners.delete(cb);
    },
    emitMessage: (data) => {
      for (const cb of [...listeners]) cb({ data });
    },
    listenerCount: () => listeners.size,
  };
  vi.stubGlobal("window", fake);
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeInAppWallet", () => {
  it("resolves false when window is undefined (SSR)", async () => {
    await expect(probeInAppWallet(10)).resolves.toBe(false);
  });

  it("resolves true immediately when window.hashpack is injected", async () => {
    stubWindow({ hashpack: {} });
    await expect(probeInAppWallet(50)).resolves.toBe(true);
  });

  it("resolves true when the parent answers hedera-iframe-response (iOS case)", async () => {
    const fake = stubWindow({ answerProbe: true });
    await expect(probeInAppWallet(500)).resolves.toBe(true);
    // Listener is cleaned up after resolving.
    expect(fake.listenerCount()).toBe(0);
  });

  it("resolves false on timeout when nothing answers (regular mobile browser)", async () => {
    const fake = stubWindow({ answerProbe: false });
    await expect(probeInAppWallet(50)).resolves.toBe(false);
    expect(fake.listenerCount()).toBe(0);
  });

  it("ignores unrelated messages", async () => {
    const fake = stubWindow({ answerProbe: false });
    const pending = probeInAppWallet(60);
    fake.emitMessage({ type: "something-else" });
    fake.emitMessage({ type: "hedera-iframe-response" }); // no metadata → ignore
    await expect(pending).resolves.toBe(false);
  });
});

describe("isHashPackInAppBrowserAsync", () => {
  it("returns true via sync signal without probing", async () => {
    const fake = stubWindow({ hashpack: {} });
    vi.stubGlobal("navigator", { userAgent: IPHONE_WKWEBVIEW_UA });
    // No postMessage spy needed: sync path returns before any probe.
    await expect(isHashPackInAppBrowserAsync()).resolves.toBe(true);
    expect(fake.listenerCount()).toBe(0);
  });

  it("detects HashPack iOS in-app browser via the iframe probe", async () => {
    stubWindow({ answerProbe: true });
    vi.stubGlobal("navigator", { userAgent: IPHONE_WKWEBVIEW_UA });
    await expect(isHashPackInAppBrowserAsync()).resolves.toBe(true);
  });

  it("returns false on desktop without probing", async () => {
    const fake = stubWindow({ answerProbe: false });
    vi.stubGlobal("navigator", { userAgent: DESKTOP_CHROME_UA });
    await expect(isHashPackInAppBrowserAsync()).resolves.toBe(false);
    // Desktop skips the probe entirely — no listener, no delay.
    expect(fake.listenerCount()).toBe(0);
  });
});
