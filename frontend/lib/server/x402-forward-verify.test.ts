/**
 * x402 2%-forward verifier tests — mirror-node fetch is fully mocked
 * (no network). Covers: verified HBAR, verified token, atomic in-tx
 * split, missing forward (honest copy), dust exemption, failed payment,
 * ambiguous payment, malformed id.
 */
import { describe, expect, it, vi } from "vitest";
import { verifyX402Forward } from "./x402-forward-verify";

const MIRROR = "https://mainnet.mirrornode.hedera.com/api/v1";
const PAY_DASH = "0.0.10571514-1727777777-123456789";
const PAY_AT = "0.0.10571514@1727777777.123456789";
const AGENT = "0.0.2002";
const BUYER = "0.0.1001";
const TREASURY = "0.0.10424063";

type Json = Record<string, unknown>;

function okJson(body: Json) {
  return { ok: true, json: async () => body };
}

function hbarPaymentTx(overrides: Json = {}): Json {
  return {
    transactions: [
      {
        transaction_id: PAY_AT,
        result: "SUCCESS",
        consensus_timestamp: "1727777777.123456789",
        transfers: [
          { account: BUYER, amount: -1000000000, is_approval: false },
          { account: AGENT, amount: 1000000000, is_approval: false },
          { account: "0.0.10571514", amount: -150000, is_approval: false },
          { account: "0.0.98", amount: 120000, is_approval: false },
        ],
        token_transfers: [],
        ...overrides,
      },
    ],
  };
}

function mockFetch(routes: Array<[string, Json]>): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    for (const [prefix, body] of routes) {
      if (url.startsWith(prefix)) return okJson(body);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const resolvePage = async () => "testagent";

describe("verifyX402Forward", () => {
  it("verifies an HBAR payment whose 2% forward landed later", async () => {
    const forwardTx = {
      transaction_id: "0.0.2002@1727780000.000000001",
      result: "SUCCESS",
      consensus_timestamp: "1727780000.000000001",
      transfers: [
        { account: AGENT, amount: -20000000, is_approval: false },
        { account: TREASURY, amount: 20000000, is_approval: false },
      ],
      token_transfers: [],
    };
    const fetchImpl = mockFetch([
      [`${MIRROR}/transactions/${PAY_DASH}`, hbarPaymentTx()],
      [`${MIRROR}/transactions?account.id=${AGENT}`, { transactions: [forwardTx] }],
    ]);
    const res = await verifyX402Forward(PAY_AT, { fetchImpl, resolvePage });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verified).toBe(true);
    expect(res.reason).toBe("forward-found");
    expect(res.agentWallet).toBe(AGENT);
    expect(res.agentPage).toBe("testagent");
    expect(res.paidAmount).toBe("1000000000");
    expect(res.paidAsset).toBe("HBAR");
    expect(res.forwardedAmount).toBe("20000000");
    expect(res.forwardTx).toBe("0.0.2002-1727780000-000000001");
    expect(res.hashscan).toContain(PAY_DASH);
  });

  it("verifies a token payment forward in the same token", async () => {
    const token = "0.0.9999";
    const payment = {
      transactions: [
        {
          transaction_id: PAY_AT,
          result: "SUCCESS",
          consensus_timestamp: "1727777777.123456789",
          transfers: [{ account: "0.0.98", amount: 120000, is_approval: false }],
          token_transfers: [
            { token_id: token, account: BUYER, amount: -5000, is_approval: false },
            { token_id: token, account: AGENT, amount: 5000, is_approval: false },
          ],
        },
      ],
    };
    const forwardTx = {
      transaction_id: "0.0.2002@1727780000.000000001",
      result: "SUCCESS",
      consensus_timestamp: "1727780000.000000001",
      transfers: [],
      token_transfers: [
        { token_id: token, account: AGENT, amount: -100, is_approval: false },
        { token_id: token, account: TREASURY, amount: 100, is_approval: false },
      ],
    };
    const fetchImpl = mockFetch([
      [`${MIRROR}/transactions/${PAY_DASH}`, payment],
      [`${MIRROR}/transactions?account.id=${AGENT}`, { transactions: [forwardTx] }],
    ]);
    const res = await verifyX402Forward(PAY_DASH, { fetchImpl, resolvePage });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verified).toBe(true);
    expect(res.reason).toBe("forward-found");
    expect(res.paidAsset).toBe(token);
    expect(res.paidAmount).toBe("5000");
    expect(res.forwardedAmount).toBe("100");
  });

  it("accepts a forward inside the payment tx itself (atomic split)", async () => {
    const payment = hbarPaymentTx({
      transfers: [
        { account: BUYER, amount: -1000000000, is_approval: false },
        { account: AGENT, amount: 980000000, is_approval: false },
        { account: TREASURY, amount: 20000000, is_approval: false },
      ],
    });
    const fetchImpl = mockFetch([[`${MIRROR}/transactions/${PAY_DASH}`, payment]]);
    const res = await verifyX402Forward(PAY_AT, { fetchImpl, resolvePage });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verified).toBe(true);
    expect(res.reason).toBe("forward-in-payment-tx");
    expect(res.forwardTx).toBe(PAY_DASH);
    expect(res.pagesScanned).toBe(0);
  });

  it("reports a missing forward honestly — never as an accusation", async () => {
    const fetchImpl = mockFetch([
      [`${MIRROR}/transactions/${PAY_DASH}`, hbarPaymentTx()],
      [`${MIRROR}/transactions?account.id=${AGENT}`, { transactions: [] }],
    ]);
    const res = await verifyX402Forward(PAY_AT, { fetchImpl, resolvePage });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verified).toBe(false);
    expect(res.reason).toBe("no-forward-in-window");
    expect(res.forwardTx).toBeNull();
    expect(res.detail).toContain("not an accusation");
    expect(res.detail).not.toMatch(/stole|theft|missing payment/i);
  });

  it("exempts dust payments instead of flagging them", async () => {
    const tiny = hbarPaymentTx({
      transfers: [
        { account: BUYER, amount: -1000, is_approval: false },
        { account: AGENT, amount: 1000, is_approval: false },
      ],
    });
    let calls = 0;
    const counting: typeof fetch = (async (input: unknown) => {
      calls++;
      const url = String(input);
      if (url.startsWith(`${MIRROR}/transactions/${PAY_DASH}`)) return okJson(tiny);
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    const res = await verifyX402Forward(PAY_AT, { fetchImpl: counting, resolvePage });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verified).toBe(false);
    expect(res.reason).toBe("dust-below-threshold");
    expect(res.detail).toContain("No forward is required");
    // Dust is decided before any scan — only the payment fetch happened.
    expect(calls).toBe(1);
  });

  it("rejects a payment tx that did not succeed", async () => {
    const failed = hbarPaymentTx({ result: "CONTRACT_REVERT_EXECUTED" });
    const fetchImpl = mockFetch([[`${MIRROR}/transactions/${PAY_DASH}`, failed]]);
    const res = await verifyX402Forward(PAY_AT, { fetchImpl, resolvePage });
    expect(res).toEqual({
      ok: false,
      error: "payment-not-successful",
      detail: expect.stringContaining("did not succeed"),
    });
  });

  it("reports an unknown transaction id", async () => {
    const fetchImpl = mockFetch([[`${MIRROR}/transactions/${PAY_DASH}`, { transactions: [] }]]);
    const res = await verifyX402Forward(PAY_AT, { fetchImpl, resolvePage });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("payment-not-found");
  });

  it("refuses to guess when several tokens move", async () => {
    const multi = {
      transactions: [
        {
          transaction_id: PAY_AT,
          result: "SUCCESS",
          consensus_timestamp: "1727777777.123456789",
          transfers: [],
          token_transfers: [
            { token_id: "0.0.9999", account: AGENT, amount: 5000, is_approval: false },
            { token_id: "0.0.8888", account: AGENT, amount: 7000, is_approval: false },
          ],
        },
      ],
    };
    const fetchImpl = mockFetch([[`${MIRROR}/transactions/${PAY_DASH}`, multi]]);
    const res = await verifyX402Forward(PAY_AT, { fetchImpl, resolvePage });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("ambiguous-payment");
  });

  it("rejects malformed transaction ids without touching the network", async () => {
    const spy = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const res = await verifyX402Forward("not-a-tx-id", {
      fetchImpl: spy as unknown as typeof fetch,
      resolvePage,
    });
    expect(res).toEqual({
      ok: false,
      error: "malformed-tx-id",
      detail: expect.stringContaining("doesn't look like"),
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("paginates with exact-string cursors (no float rounding)", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      transaction_id: `0.0.2002@1727777800.${String(100000000 + i).padStart(9, "0")}`,
      result: "SUCCESS",
      consensus_timestamp: `1727777800.${String(100000000 + i).padStart(9, "0")}`,
      transfers: [{ account: AGENT, amount: -1, is_approval: false }],
      token_transfers: [],
    }));
    let scanCalls = 0;
    const seen: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith(`${MIRROR}/transactions/${PAY_DASH}`)) return okJson(hbarPaymentTx());
      if (url.startsWith(`${MIRROR}/transactions?account.id=${AGENT}`)) {
        scanCalls++;
        return okJson({ transactions: scanCalls === 1 ? page1 : [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    // Second page request must carry an exact gt: cursor, not a rounded float.
    const res = await verifyX402Forward(PAY_AT, { fetchImpl, resolvePage });
    expect(res.ok).toBe(true);
    const urls = seen.filter((u) => u.includes("transactions?account.id="));
    expect(urls.length).toBe(2);
    expect(urls[1]).toContain("timestamp=gt%3A1727777800.100000099");
    // Regression: the mirror node rejects `type=` ("Invalid parameter: type")
    // — the scan must use `transactiontype=cryptotransfer`.
    expect(urls[0]).toContain("transactiontype=cryptotransfer");
    expect(urls[0]).not.toContain("type=CRYPTOTRANSFER");
    if (res.ok) expect(res.pagesScanned).toBe(2);
  });
});
