import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetReportErrorSeenForTests, extractErrorDetails, reportError } from "./report-error";

function installBrowserStubs() {
  const sendBeacon = vi.fn(() => true);
  (globalThis as Record<string, unknown>).window = {
    location: { pathname: "/some/page?ref=private&x=1" },
  };
  (globalThis as Record<string, unknown>).navigator = { sendBeacon };
  return sendBeacon;
}

function uninstallBrowserStubs() {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).navigator;
}

beforeEach(() => {
  uninstallBrowserStubs();
  __resetReportErrorSeenForTests();
});

describe("reportError", () => {
  it("sends message, page (no query string), and component via sendBeacon", () => {
    const sendBeacon = installBrowserStubs();
    reportError(new Error("tip boom"), "tip-modal");
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0] as unknown as [string, Blob];
    expect(url).toBe("/api/client-error");
    expect(blob.type).toBe("application/json");
    return blob.text().then((text) => {
      const body = JSON.parse(text) as Record<string, string>;
      expect(body.message).toBe("tip boom");
      expect(body.page).toBe("/some/page");
      expect(body.component).toBe("tip-modal");
    });
  });

  it("scrubs wallet addresses and account IDs from the message", () => {
    const sendBeacon = installBrowserStubs();
    reportError(
      new Error("failed for 0x1234567890abcdef and account 0.0.10424063 today"),
      "tip-modal",
    );
    const [, blob] = sendBeacon.mock.calls[0] as unknown as [string, Blob];
    return blob.text().then((text) => {
      const body = JSON.parse(text) as Record<string, string>;
      expect(body.message).not.toContain("0x1234567890abcdef");
      expect(body.message).not.toContain("0.0.10424063");
      expect(body.message).toContain("0x…");
      expect(body.message).toContain("0.0.…");
    });
  });

  it("accepts a plain string error", () => {
    const sendBeacon = installBrowserStubs();
    reportError("plain string failure", "sign-in");
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it("dedups identical reports and caps at 10 unique per load", () => {
    const sendBeacon = installBrowserStubs();
    for (let i = 0; i < 15; i++) reportError(new Error(`unique-${i}`), "x");
    expect(sendBeacon).toHaveBeenCalledTimes(10);
    // Same message again — still capped, no resend.
    reportError(new Error("unique-0"), "x");
    expect(sendBeacon).toHaveBeenCalledTimes(10);
  });

  it("is fail-silent without a browser environment", () => {
    expect(() => reportError(new Error("boom"), "x")).not.toThrow();
  });

  it("is fail-silent when sendBeacon throws", () => {
    installBrowserStubs();
    (globalThis as Record<string, unknown>).navigator = {
      sendBeacon: () => {
        throw new Error("beacon down");
      },
    };
    expect(() => reportError(new Error("boom"), "x")).not.toThrow();
  });

  it("falls back to keepalive fetch when sendBeacon is missing", async () => {
    (globalThis as Record<string, unknown>).window = {
      location: { pathname: "/" },
    };
    (globalThis as Record<string, unknown>).navigator = {};
    const fetchMock = vi.fn(() => Promise.resolve(new Response("ok")));
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    try {
      reportError(new Error("fallback path"), "x");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(opts.keepalive).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).fetch;
    }
  });

  it("carries name, action, and walletState in the payload when given", () => {
    const sendBeacon = installBrowserStubs();
    reportError(new TypeError("bad call"), "tip-modal", {
      action: "tip-submit",
      walletState: "connected",
    });
    const [, blob] = sendBeacon.mock.calls[0] as unknown as [string, Blob];
    return blob.text().then((text) => {
      const body = JSON.parse(text) as Record<string, string>;
      expect(body.message).toBe("bad call");
      expect(body.name).toBe("TypeError");
      expect(body.action).toBe("tip-submit");
      expect(body.walletState).toBe("connected");
    });
  });

  it("omits name/action/walletState when not provided", () => {
    const sendBeacon = installBrowserStubs();
    reportError(new Error("plain"), "x");
    const [, blob] = sendBeacon.mock.calls[0] as unknown as [string, Blob];
    return blob.text().then((text) => {
      const body = JSON.parse(text) as Record<string, string>;
      expect("action" in body).toBe(false);
      expect("walletState" in body).toBe(false);
    });
  });

  it("rejects a bogus walletState instead of storing it", () => {
    const sendBeacon = installBrowserStubs();
    reportError(new Error("plain"), "x", {
      walletState: "0.0.12345" as unknown as "connected",
    });
    const [, blob] = sendBeacon.mock.calls[0] as unknown as [string, Blob];
    return blob.text().then((text) => {
      const body = JSON.parse(text) as Record<string, string>;
      expect("walletState" in body).toBe(false);
    });
  });
});

describe("extractErrorDetails", () => {
  it("uses the Error message and keeps the error name", () => {
    expect(extractErrorDetails(new TypeError("bad call"))).toEqual({
      message: "bad call",
      name: "TypeError",
    });
  });

  it("names an Error with an empty message instead of saying 'unknown error'", () => {
    const e = new Error();
    e.name = "WalletTimeoutError";
    expect(extractErrorDetails(e)).toEqual({
      message: "WalletTimeoutError (no message)",
      name: "WalletTimeoutError",
    });
  });

  it("extracts message + code from WalletConnect-style plain-object rejections", () => {
    // This is the class of failure that used to record "unknown error".
    expect(extractErrorDetails({ code: 5000, message: "User rejected the request." })).toEqual({
      message: "User rejected the request. (code 5000)",
      name: null,
    });
  });

  it("handles a code-only thrown object", () => {
    expect(extractErrorDetails({ code: 4001 })).toEqual({
      message: "thrown object (code 4001)",
      name: null,
    });
  });

  it("dumps an otherwise opaque thrown object instead of giving up", () => {
    const d = extractErrorDetails({ reason: "weird", nested: { a: 1 } });
    expect(d.message).toContain("thrown object");
    expect(d.message).toContain("weird");
  });

  it("survives circular thrown objects", () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(() => extractErrorDetails(o)).not.toThrow();
    expect(extractErrorDetails(o).message).toBe("thrown object");
  });

  it("distinguishes null, undefined, and primitive thrown values", () => {
    expect(extractErrorDetails(null).message).toBe("thrown null");
    expect(extractErrorDetails(undefined).message).toBe("thrown undefined");
    expect(extractErrorDetails(42).message).toBe("thrown 42");
    expect(extractErrorDetails(false).message).toBe("thrown false");
  });

  it("accepts plain strings", () => {
    expect(extractErrorDetails("plain string failure")).toEqual({
      message: "plain string failure",
      name: null,
    });
  });
});
