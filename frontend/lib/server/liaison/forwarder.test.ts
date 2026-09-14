/**
 * Tests for the liaison revenue sweep (lib/server/liaison/forwarder.ts).
 * The chain transfer is stubbed — only the sweep decision logic runs.
 */
import { describe, expect, it, vi } from "vitest";
import { forwardLiaisonRevenue } from "./forwarder";

const KEY_ENV = { LIAISON_FORWARDER_KEY: "test-key-not-real" };

function mirrorWithBalance(tinybar: bigint) {
  return async (_path: string) => ({
    ok: true,
    json: { balance: { balance: tinybar.toString() } },
  });
}

describe("forwardLiaisonRevenue", () => {
  it("skips the sweep when no forwarder key is configured", async () => {
    const executeTransfer = vi.fn(async (_a: bigint) => "0.0.1@2.3");
    const r = await forwardLiaisonRevenue({
      mirrorGet: mirrorWithBalance(500_000_000n),
      executeTransfer,
      env: {},
    });
    expect(r.forwarded).toBe(false);
    expect(r.reason).toMatch(/not configured/);
    expect(executeTransfer).not.toHaveBeenCalled();
  });

  it("skips the sweep when the balance sits below the reserve", async () => {
    const executeTransfer = vi.fn(async (_a: bigint) => "0.0.1@2.3");
    const r = await forwardLiaisonRevenue({
      mirrorGet: mirrorWithBalance(50_000_000n), // 0.5 HBAR < 1 HBAR reserve
      executeTransfer,
      env: KEY_ENV,
    });
    expect(r.forwarded).toBe(false);
    expect(executeTransfer).not.toHaveBeenCalled();
  });

  it("forwards everything above the reserve by default", async () => {
    const executeTransfer = vi.fn(async (_a: bigint) => "0.0.1@2.3");
    const r = await forwardLiaisonRevenue({
      mirrorGet: mirrorWithBalance(250_000_000n), // 2.5 HBAR
      executeTransfer,
      env: KEY_ENV,
    });
    expect(r.forwarded).toBe(true);
    expect(r.txId).toBe("0.0.1@2.3");
    expect(executeTransfer).toHaveBeenCalledWith(150_000_000n); // 1.5 HBAR
  });

  it("honors the threshold env (must EXCEED it)", async () => {
    const executeTransfer = vi.fn(async (_a: bigint) => "0.0.1@2.3");
    const env = { ...KEY_ENV, LIAISON_FORWARD_THRESHOLD_HBAR: "0.2" };
    // 1.1 HBAR balance → 0.1 forwardable, under the 0.2 threshold.
    const skipped = await forwardLiaisonRevenue({
      mirrorGet: mirrorWithBalance(110_000_000n),
      executeTransfer,
      env,
    });
    expect(skipped.forwarded).toBe(false);
    expect(executeTransfer).not.toHaveBeenCalled();
    // 1.3 HBAR balance → 0.3 forwardable, over the threshold.
    const swept = await forwardLiaisonRevenue({
      mirrorGet: mirrorWithBalance(130_000_000n),
      executeTransfer,
      env,
    });
    expect(swept.forwarded).toBe(true);
    expect(executeTransfer).toHaveBeenCalledWith(30_000_000n);
  });

  it("never throws — a failed transfer just reports not-forwarded", async () => {
    const r = await forwardLiaisonRevenue({
      mirrorGet: mirrorWithBalance(250_000_000n),
      executeTransfer: async (_a: bigint) => {
        throw new Error("node unreachable");
      },
      env: KEY_ENV,
    });
    expect(r.forwarded).toBe(false);
    expect(r.reason).toMatch(/node unreachable/);
  });

  it("treats a failed mirror read as a skip, not a crash", async () => {
    const executeTransfer = vi.fn(async (_a: bigint) => "0.0.1@2.3");
    const r = await forwardLiaisonRevenue({
      mirrorGet: async (_p: string) => ({ ok: false, json: null }),
      executeTransfer,
      env: KEY_ENV,
    });
    expect(r.forwarded).toBe(false);
    expect(executeTransfer).not.toHaveBeenCalled();
  });
});
