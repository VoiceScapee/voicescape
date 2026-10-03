import { describe, expect, it } from "vitest";
import {
  decidePairingChannel,
  detectHashPackInAppBrowser,
  detectInjectedHederaWallet,
  disconnectStaleSessions,
  friendlyWalletError,
  IN_APP_HANDSHAKE_FAILED_COPY,
  IN_APP_MODAL_BLOCKED_COPY,
  isPairingCancelled,
  PairingCancelledError,
  sessionTopic,
  shouldSuggestWalletInstall,
  SingleFlight,
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

describe("SingleFlight — double-tap never starts a second pairing", () => {
  it("shares the in-flight attempt: start() runs exactly once", async () => {
    const flight = new SingleFlight<string>();
    let starts = 0;
    let resolveIt!: (v: string) => void;
    const p1 = flight.run(
      () =>
        new Promise<string>((resolve) => {
          starts++;
          resolveIt = resolve;
        }),
    );
    const p2 = flight.run(
      () =>
        new Promise<string>((resolve) => {
          starts++;
          resolve("second");
        }),
    );
    expect(p2).toBe(p1);
    expect(starts).toBe(1);
    expect(flight.inFlight).toBe(true);
    resolveIt("first");
    await expect(p1).resolves.toBe("first");
    await expect(p2).resolves.toBe("first");
    expect(flight.inFlight).toBe(false);
  });

  it("a retry after success starts a fresh attempt", async () => {
    const flight = new SingleFlight<string>();
    let starts = 0;
    await flight.run(async () => {
      starts++;
      return "one";
    });
    const result = await flight.run(async () => {
      starts++;
      return "two";
    });
    expect(result).toBe("two");
    expect(starts).toBe(2);
  });

  it("a retry after failure starts a fresh attempt, and the rejection reaches every waiter", async () => {
    const flight = new SingleFlight<string>();
    let starts = 0;
    const fail = () =>
      flight.run(async () => {
        starts++;
        throw new Error("pairing timed out");
      });
    const p1 = fail();
    const p2 = fail();
    await expect(p1).rejects.toThrow("pairing timed out");
    await expect(p2).rejects.toThrow("pairing timed out");
    expect(starts).toBe(1);
    // Guard cleared on rejection — the next tap retries instead of
    // hanging on the dead attempt.
    await expect(
      flight.run(async () => {
        starts++;
        return "recovered";
      }),
    ).resolves.toBe("recovered");
    expect(starts).toBe(2);
  });
});

describe("sessionTopic — approved session topic extraction", () => {
  it("extracts the topic string", () => {
    expect(sessionTopic({ topic: "abc123", namespaces: {} })).toBe("abc123");
  });

  it("returns null when the topic is missing or not a string", () => {
    expect(sessionTopic({})).toBeNull();
    expect(sessionTopic({ topic: 42 })).toBeNull();
    expect(sessionTopic({ topic: "" })).toBeNull();
    expect(sessionTopic(null)).toBeNull();
    expect(sessionTopic(undefined)).toBeNull();
    expect(sessionTopic("abc")).toBeNull();
  });
});

describe("disconnectStaleSessions — sessions only, never pairings", () => {
  type Conn = Parameters<typeof disconnectStaleSessions>[0];

  function mockConnector(topics: string[], opts?: { throwOn?: string }) {
    const disconnected: string[] = [];
    const pairingCalls: string[] = [];
    const connector = {
      walletConnectClient: {
        session: { getAll: () => topics.map((topic) => ({ topic })) },
        core: {
          pairing: {
            getPairings: () => {
              pairingCalls.push("getPairings");
              return [];
            },
          },
        },
      },
      disconnect: async (topic: string) => {
        if (opts?.throwOn === topic) throw new Error("relay hiccup");
        disconnected.push(topic);
      },
    };
    return { connector: connector as unknown as Conn, disconnected, pairingCalls };
  }

  it("disconnects stale sessions but keeps the newly approved one", async () => {
    const { connector, disconnected, pairingCalls } = mockConnector([
      "old-a",
      "new-topic",
      "old-b",
    ]);
    await disconnectStaleSessions(connector, "new-topic");
    expect(disconnected.sort()).toEqual(["old-a", "old-b"]);
    // The relay's pairing store is never consulted — a pending approval
    // sheet survives cleanup.
    expect(pairingCalls).toEqual([]);
  });

  it("does nothing when the new session topic is unknown", async () => {
    const { connector, disconnected, pairingCalls } = mockConnector(["old-a"]);
    await disconnectStaleSessions(connector, null);
    expect(disconnected).toEqual([]);
    expect(pairingCalls).toEqual([]);
  });

  it("is best-effort: one failing disconnect does not stop the rest", async () => {
    const { connector, disconnected } = mockConnector(["old-a", "old-b"], {
      throwOn: "old-a",
    });
    await disconnectStaleSessions(connector, "new-topic");
    expect(disconnected).toEqual(["old-b"]);
  });

  it("does nothing when there is no client (init failed)", async () => {
    const conn = { walletConnectClient: null, disconnect: async () => {} };
    await expect(
      disconnectStaleSessions(conn as unknown as Conn, "new-topic"),
    ).resolves.toBeUndefined();
  });
});

describe("friendlyWalletError — plain-object rejections never render [object Object]", () => {
  const declined = "You declined the transaction in your wallet — nothing was sent.";

  it("maps a WalletConnect plain-object user rejection to the calm declined copy", () => {
    // SignClient rejects approval() with {code, message}, not an Error.
    expect(friendlyWalletError({ code: 5000, message: "User rejected." })).toBe(declined);
  });

  it("prefers a real message field on plain objects", () => {
    expect(friendlyWalletError({ message: "boom" })).toBe("boom");
  });

  it("falls back to a human sentence when the object carries no message", () => {
    const out = friendlyWalletError({ code: -32000 });
    expect(out).not.toContain("[object Object]");
    expect(out.length).toBeGreaterThan(10);
  });

  it("falls back to a human sentence for empty values", () => {
    for (const v of [undefined, null, ""]) {
      const out = friendlyWalletError(v);
      expect(out).not.toContain("[object Object]");
      expect(out.length).toBeGreaterThan(10);
    }
  });

  it("still passes strings through unchanged", () => {
    expect(friendlyWalletError("custom copy")).toBe("custom copy");
  });

  it("never emits [object Object] for a battery of hostile inputs", () => {
    const inputs: unknown[] = [
      { code: 5000, message: "User rejected." },
      { code: 9000 },
      {},
      [],
      42,
      true,
      { message: 42 },
      { nested: { message: "deep" } },
    ];
    for (const input of inputs) {
      expect(friendlyWalletError(input)).not.toContain("[object Object]");
    }
  });
});
