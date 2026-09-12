/**
 * Tests for on-chain transaction verification.
 *
 * The wallet receipt only proves submission, not on-chain success.
 * These helpers poll the Mirror Node and distinguish three outcomes:
 * confirmed, failed, and unknown (submitted but not yet visible).
 * Callers must NEVER report "failed" for the unknown case — money may
 * have moved.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyTipOnChain, verifyPurchaseOnChain } from "./verify-tx";

const TIPSENT_TOPIC = "0xddb557901a5c7e767f2276c1190ca61ae148d62a74cfa61e4f7fa5319eaa431e";
const PURCHASE_TOPIC = "0x8555727c6813e10ae0b5a9b0a53a88a93176679845f5a005a248cdb9f1c05f2e";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetchOnce(response: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce({
      ok,
      json: async () => response,
    }),
  );
}

describe("verifyTipOnChain", () => {
  it("returns confirmed when the TipSent event is present with success status", async () => {
    mockFetchOnce({
      status: "0x1",
      amount: "1000000",
      logs: [{ topics: [TIPSENT_TOPIC] }],
    });
    const result = await verifyTipOnChain("0.0.10424063-1234567890-123456789", 1, 1);
    expect(result.status).toBe("confirmed");
  });

  it("returns failed when the transaction reverted on-chain", async () => {
    mockFetchOnce({
      status: "0x0",
      amount: "0",
      logs: [],
    });
    const result = await verifyTipOnChain("0.0.10424063-1234567890-123456789", 1, 1);
    expect(result.status).toBe("failed");
  });

  it("returns unknown (not failed) when the mirror node has no result yet", async () => {
    // 404 / not-ok responses are retried, then give up as "unknown".
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    const result = await verifyTipOnChain("0xabcdef1234567890", 2, 1);
    expect(result.status).toBe("unknown");
  });

  it("accepts EVM transaction hashes (0x…) as well as SDK tx IDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "0x1",
        amount: "500000",
        logs: [{ topics: [TIPSENT_TOPIC] }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await verifyTipOnChain("0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef", 1, 1);
    expect(result.status).toBe("confirmed");
    // The hash is passed through to the mirror node URL verbatim.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"),
    );
  });
});

describe("verifyPurchaseOnChain", () => {
  it("returns confirmed when the PurchaseCompleted event is present", async () => {
    mockFetchOnce({
      status: "0x1",
      amount: "2000000",
      logs: [{ topics: [PURCHASE_TOPIC] }],
    });
    const result = await verifyPurchaseOnChain("0.0.10424063-1234567890-123456789", 1, 1);
    expect(result.status).toBe("confirmed");
  });

  it("does not confuse TipSent logs for a purchase", async () => {
    mockFetchOnce({
      status: "0x1",
      amount: "1000000",
      logs: [{ topics: [TIPSENT_TOPIC] }],
    });
    // One attempt: result exists with success status and amount but the
    // wrong event → keeps polling → exhausts attempts → unknown.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: "0x1",
          amount: "1000000",
          logs: [{ topics: [TIPSENT_TOPIC] }],
        }),
      }),
    );
    const result = await verifyPurchaseOnChain("0.0.10424063-1234567890-123456789", 1, 1);
    expect(result.status).toBe("unknown");
  });
});
