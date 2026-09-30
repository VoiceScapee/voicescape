import { describe, expect, it, vi } from "vitest";
import { isStaleConnectionError, repairStaleConnection } from "./wallet";

describe("isStaleConnectionError", () => {
  it("matches the real stale-session tip failure copy", () => {
    expect(
      isStaleConnectionError(
        "Tip failed: HashPack didn't respond — your wallet connection is stale. Disconnect Voicescape in HashPack's connected apps, sign out here, then reconnect and try again.",
      ),
    ).toBe(true);
  });

  it("matches the wallet-timeout copy", () => {
    expect(
      isStaleConnectionError(
        "Your wallet didn't respond in time. The transaction may still have gone through — we're checking on-chain now instead of guessing.",
      ),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isStaleConnectionError("STALE session detected")).toBe(true);
    expect(isStaleConnectionError("WALLET DIDN'T RESPOND")).toBe(true);
  });

  it("does not match amount/connection/registration errors", () => {
    expect(isStaleConnectionError("Enter a valid HBAR amount.")).toBe(false);
    expect(isStaleConnectionError("Connect a wallet to tip.")).toBe(false);
    expect(isStaleConnectionError("@someone isn't registered on-chain — the tip would fail.")).toBe(false);
    expect(isStaleConnectionError("You declined the transaction in your wallet — nothing was sent.")).toBe(false);
  });

  it("is false for empty or missing messages", () => {
    expect(isStaleConnectionError("")).toBe(false);
    expect(isStaleConnectionError(null)).toBe(false);
    expect(isStaleConnectionError(undefined)).toBe(false);
  });
});

describe("repairStaleConnection", () => {
  it("signs out BEFORE starting the fresh pairing, with the same adapter", async () => {
    const order: string[] = [];
    const signOut = vi.fn(() => {
      order.push("signOut");
    });
    const connect = vi.fn(async (adapterId: string) => {
      order.push(`connect:${adapterId}`);
      return "0.0.123";
    });

    await repairStaleConnection({ signOut, connect, adapterId: "hashpack" });

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("hashpack");
    // The dead session must be cleared before the new pairing starts.
    expect(order).toEqual(["signOut", "connect:hashpack"]);
  });

  it("propagates the connect failure after signOut ran", async () => {
    const signOut = vi.fn();
    const failure = new Error("HashPack did not approve the connection.");
    const connect = vi.fn(async () => {
      throw failure;
    });

    await expect(
      repairStaleConnection({ signOut, connect, adapterId: "blade" }),
    ).rejects.toBe(failure);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("blade");
  });
});
