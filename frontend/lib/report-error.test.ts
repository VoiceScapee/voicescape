import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetReportErrorSeenForTests, reportError } from "./report-error";

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
});
