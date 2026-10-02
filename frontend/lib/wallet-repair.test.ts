import { describe, expect, it, vi } from "vitest";
import {
  __probePairingLiveness,
  isStaleConnectionError,
  isWalletSessionAlive,
  repairStaleConnection,
  rewakeHederaPairing,
  STALE_CONNECTION_COPY,
} from "./wallet";

describe("isStaleConnectionError", () => {
  it("matches the real stale-session tip failure copy", () => {
    expect(
      isStaleConnectionError(
        "Tip failed: HashPack didn't respond — the wallet connection went stale. Reconnect your wallet and try again.",
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

describe("STALE_CONNECTION_COPY", () => {
  it("is the single copy the repair button keys off", () => {
    expect(isStaleConnectionError(STALE_CONNECTION_COPY)).toBe(true);
    expect(STALE_CONNECTION_COPY).toContain("HashPack didn't respond");
  });
});

describe("__probePairingLiveness", () => {
  function fakePairing(opts: {
    accountId?: string;
    signers?: { getAccountId: () => { toString: () => string }; getAccountBalance: () => Promise<unknown> }[];
  }) {
    return {
      hc: { signers: opts.signers ?? [] },
      accountId: opts.accountId ?? "0.0.123",
    } as unknown as Parameters<typeof __probePairingLiveness>[0];
  }

  function liveSigner(accountId: string) {
    return {
      getAccountId: () => ({ toString: () => accountId }),
      getAccountBalance: async () => ({ hbars: 1 }),
    };
  }

  it("returns true when the wallet answers the balance query", async () => {
    const pairing = fakePairing({ signers: [liveSigner("0.0.123")] });
    await expect(__probePairingLiveness(pairing, 1000)).resolves.toBe(true);
  });

  it("returns false when the wallet rejects the query (stale session)", async () => {
    const dead = {
      getAccountId: () => ({ toString: () => "0.0.123" }),
      getAccountBalance: async () => {
        throw new Error("No session");
      },
    };
    const pairing = fakePairing({ signers: [dead] });
    await expect(__probePairingLiveness(pairing, 1000)).resolves.toBe(false);
  });

  it("returns false when the balance query hangs past the timeout", async () => {
    const hanging = {
      getAccountId: () => ({ toString: () => "0.0.123" }),
      getAccountBalance: () => new Promise(() => {}),
    };
    const pairing = fakePairing({ signers: [hanging] });
    await expect(__probePairingLiveness(pairing, 50)).resolves.toBe(false);
  });

  it("returns false when there are no signers", async () => {
    const pairing = fakePairing({ signers: [] });
    await expect(__probePairingLiveness(pairing, 1000)).resolves.toBe(false);
  });

  it("prefers the signer matching the paired account", async () => {
    const asked: string[] = [];
    const mk = (id: string, alive: boolean) => ({
      getAccountId: () => ({ toString: () => id }),
      getAccountBalance: async () => {
        asked.push(id);
        if (!alive) throw new Error("dead");
        return {};
      },
    });
    const pairing = fakePairing({ accountId: "0.0.999", signers: [mk("0.0.111", false), mk("0.0.999", true)] });
    await expect(__probePairingLiveness(pairing, 1000)).resolves.toBe(true);
    expect(asked).toEqual(["0.0.999"]);
  });

  it("never throws, even for a throwing getAccountId", async () => {
    const bad = {
      getAccountId: () => {
        throw new Error("nope");
      },
      getAccountBalance: async () => ({}),
    };
    const pairing = fakePairing({ signers: [bad] });
    // getAccountId throws on the only signer → falls back to signers[0],
    // whose balance query succeeds → alive.
    await expect(__probePairingLiveness(pairing, 1000)).resolves.toBe(true);
  });
});

describe("isWalletSessionAlive", () => {
  it("returns false when no pairing exists (module starts unpaired)", async () => {
    // Fresh module state in tests has no connector — never claims stale,
    // just reports no live session.
    await expect(isWalletSessionAlive(50)).resolves.toBe(false);
  });
});

describe("rewakeHederaPairing", () => {
  const fakePairing = { hc: {}, accountId: "0.0.123" } as never;

  it("drops, restores, and returns the fresh pairing", async () => {
    const order: string[] = [];
    const result = await rewakeHederaPairing({
      drop: () => {
        order.push("drop");
      },
      restore: async () => {
        order.push("restore");
        return "0.0.123";
      },
      read: () => {
        order.push("read");
        return fakePairing;
      },
    });
    expect(order).toEqual(["drop", "restore", "read"]);
    expect(result).toBe(fakePairing);
  });

  it("returns null (never throws) when the restore finds no session", async () => {
    const result = await rewakeHederaPairing({
      drop: () => {},
      restore: async () => null,
      read: () => fakePairing,
    });
    expect(result).toBeNull();
  });

  it("returns null when the restore throws", async () => {
    const result = await rewakeHederaPairing({
      drop: () => {},
      restore: async () => {
        throw new Error("relay down");
      },
      read: () => fakePairing,
    });
    expect(result).toBeNull();
  });

  it("returns null when the rebuild exceeds the timeout", async () => {
    const result = await rewakeHederaPairing({
      drop: () => {},
      restore: () => new Promise<string | null>(() => {}), // never settles
      read: () => fakePairing,
      timeoutMs: 20,
    });
    expect(result).toBeNull();
  });

  it("returns null when the drop itself throws", async () => {
    const result = await rewakeHederaPairing({
      drop: () => {
        throw new Error("nope");
      },
      restore: async () => "0.0.123",
      read: () => fakePairing,
    });
    expect(result).toBeNull();
  });
});
