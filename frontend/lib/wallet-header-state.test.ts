import { describe, expect, it } from "vitest";
import { resolveInAppHeaderState } from "./wallet";

const base = {
  inHashPackBrowser: true,
  account: null as string | null,
  isConnecting: false,
  bootSettled: true,
  userDisconnected: false,
  error: null as string | null,
  signInError: null as string | null,
};

describe("resolveInAppHeaderState — no unsolicited Connecting…", () => {
  it("shows connecting while boot detection is still running", () => {
    expect(resolveInAppHeaderState({ ...base, bootSettled: false })).toBe("connecting");
  });

  it("shows connecting while a real connect attempt is in flight", () => {
    expect(resolveInAppHeaderState({ ...base, isConnecting: true })).toBe("connecting");
  });

  it("never shows connecting after the user explicitly disconnected", () => {
    // Regression: disconnecting inside the in-app browser used to leave a
    // frozen "Connecting…" in the header while nothing was connecting.
    expect(resolveInAppHeaderState({ ...base, userDisconnected: true })).toBe("retry");
    expect(
      resolveInAppHeaderState({ ...base, userDisconnected: true, bootSettled: false }),
    ).toBe("retry");
  });

  it("offers retry (not connecting) when boot settled with nothing happening", () => {
    expect(resolveInAppHeaderState(base)).toBe("retry");
  });

  it("falls through to the picker when a connection error is showing", () => {
    expect(resolveInAppHeaderState({ ...base, error: "nope" })).toBe("default");
    expect(resolveInAppHeaderState({ ...base, signInError: "nope" })).toBe("default");
  });

  it("falls through when not in the in-app browser or already connected", () => {
    expect(resolveInAppHeaderState({ ...base, inHashPackBrowser: false })).toBe("default");
    expect(resolveInAppHeaderState({ ...base, account: "0.0.123" })).toBe("default");
  });
});

describe("friendlyWalletError", () => {
  it("maps the wallet-library 'call' init race to actionable copy", async () => {
    const { friendlyWalletError } = await import("./wallet");
    expect(
      friendlyWalletError(new TypeError("Cannot read properties of undefined (reading 'call')")),
    ).toBe("HashPack didn't finish initializing — reopen or reconnect HashPack, then try again.");
  });

  it("passes unknown errors through unchanged", async () => {
    const { friendlyWalletError } = await import("./wallet");
    expect(friendlyWalletError(new Error("User rejected the request."))).toBe(
      "User rejected the request.",
    );
    expect(friendlyWalletError("plain string")).toBe("plain string");
  });
});
