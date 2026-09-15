/**
 * Payment claim tests for POST /api/a2a/paid.
 *
 * Fixtures mirror the REAL testnet mirror-node response shapes (validated
 * against https://testnet.mirrornode.hedera.com on 2026-09-15); only the
 * HTTP layer is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claimPayment } from "./verify";
import {
  __resetPaidStore,
  __testClaim,
  getOrder,
  putOrder,
  type PaidOrder,
} from "./store";
import { ORDER_TTL_MS, PRICE_HBAR } from "./config";

const TIPS = "0.0.12345";
const TIPS_LONG_ZERO = "0x0000000000000000000000000000000000003039"; // 0.0.12345
const RECIPIENT = "test-recipient";
const ENV = { A2A_TESTNET_TIPS_ID: TIPS, A2A_RECIPIENT_USERNAME: RECIPIENT };
const NOW = 1_000_000;

function makeOrder(overrides: Partial<PaidOrder> = {}): PaidOrder {
  const orderId = overrides.orderId ?? "ord1";
  return {
    orderId,
    product: "chat-50",
    buyerAccount: "0.0.999",
    priceHbar: PRICE_HBAR,
    memo: `vs-order:${orderId}`,
    recipientUsername: RECIPIENT,
    expiresAt: NOW + ORDER_TTL_MS,
    state: "issued",
    ...overrides,
  };
}

/** Build real tipPage(string) calldata for a username (selector + ABI string). */
function tipCalldata(username: string): string {
  const data = Buffer.from(username, "utf8");
  const offsetWord = "0".repeat(62) + "20"; // 32
  const lenWord = data.length.toString(16).padStart(64, "0");
  const paddedLen = Math.ceil(data.length / 32) * 32;
  const dataPadded = data.toString("hex").padEnd(paddedLen * 2, "0");
  return "0x8b0de5cb" + offsetWord + lenWord + dataPadded;
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** Mirror-shaped tx record. */
function txRecord(overrides: Record<string, unknown> = {}) {
  return {
    result: "SUCCESS",
    entity_id: TIPS,
    memo_base64: b64("vs-order:ord1"),
    transaction_id: "0.0.999-1789000000-000000000",
    charged_tx_fee: 100000,
    ...overrides,
  };
}

/** Mirror-shaped contract result. */
function contractResult(overrides: Record<string, unknown> = {}) {
  return {
    status: "0x1",
    to: TIPS_LONG_ZERO,
    amount: String(5e8),
    function_parameters: tipCalldata(RECIPIENT),
    contract_id: TIPS,
    ...overrides,
  };
}

function mockFetch(opts: {
  tx?: Record<string, unknown> | null;
  cr?: Record<string, unknown> | null;
} = {}) {
  const { tx = txRecord(), cr = contractResult() } = opts;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const u = String(url);
    if (u.includes("/contracts/results/")) {
      if (cr === null)
        return { status: 404, ok: false, json: async () => ({}) } as Response;
      return { status: 200, ok: true, json: async () => cr } as Response;
    }
    if (u.includes("/transactions/")) {
      if (tx === null)
        return { status: 404, ok: false, json: async () => ({}) } as Response;
      return {
        status: 200,
        ok: true,
        json: async () => ({ transactions: [tx] }),
      } as Response;
    }
    throw new Error(`unexpected url ${u}`);
  });
}

const fastDeps = {
  env: ENV,
  now: () => NOW,
  attempts: 2,
  intervalMs: 0,
  sleep: async () => {},
};

beforeEach(() => {
  __resetPaidStore();
  putOrder(makeOrder());
});

describe("claimPayment", () => {
  it("verifies and pays exactly once (happy path)", async () => {
    const res = await claimPayment(
      { orderId: "ord1", txId: "0.0.999-1789000000-000000000" },
      { ...fastDeps, fetchFn: mockFetch() },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entitlement.orderId).toBe("ord1");
    expect(res.entitlement.product).toBe("chat-50");
    expect(res.entitlement.txId).toBe("0.0.999-1789000000-000000000");
    expect(getOrder("ord1")?.state).toBe("paid");
  });

  it("rejects a double claim of the same tx", async () => {
    const txId = "0.0.999-1789000000-000000000";
    const first = await claimPayment({ orderId: "ord1", txId }, {
      ...fastDeps,
      fetchFn: mockFetch(),
    });
    expect(first.ok).toBe(true);
    const second = await claimPayment({ orderId: "ord1", txId }, {
      ...fastDeps,
      fetchFn: mockFetch(),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("already_claimed");
  });

  it("rejects a tx already claimed against another order", async () => {
    const txId = "0.0.999-1789000000-000000000";
    __testClaim(txId, "other-order");
    const res = await claimPayment({ orderId: "ord1", txId }, {
      ...fastDeps,
      fetchFn: mockFetch(),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("already_claimed");
  });

  it("rejects a memo that does not bind the order", async () => {
    const res = await claimPayment(
      { orderId: "ord1", txId: "0.0.999-1789000000-000000000" },
      {
        ...fastDeps,
        fetchFn: mockFetch({ tx: txRecord({ memo_base64: b64("vs-order:WRONG") }) }),
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("memo_mismatch");
    expect(getOrder("ord1")?.state).toBe("issued"); // never half-accepted
  });

  it("rejects underpayment", async () => {
    const res = await claimPayment(
      { orderId: "ord1", txId: "0.0.999-1789000000-000000000" },
      {
        ...fastDeps,
        fetchFn: mockFetch({ cr: contractResult({ amount: String(1e8) }) }),
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("underpaid");
  });

  it("rejects expired orders", async () => {
    putOrder(makeOrder({ orderId: "old", expiresAt: NOW - 1 }));
    const res = await claimPayment(
      { orderId: "old", txId: "0.0.999-1789000000-000000000" },
      { ...fastDeps, fetchFn: mockFetch() },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("order_expired");
  });

  it("rejects failed on-chain transactions", async () => {
    const res = await claimPayment(
      { orderId: "ord1", txId: "0.0.999-1789000000-000000000" },
      {
        ...fastDeps,
        fetchFn: mockFetch({ tx: txRecord({ result: "CONTRACT_REVERT_EXECUTED" }) }),
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("tx_failed");
  });

  it("rejects payments to the wrong contract", async () => {
    const res = await claimPayment(
      { orderId: "ord1", txId: "0.0.999-1789000000-000000000" },
      {
        ...fastDeps,
        fetchFn: mockFetch({ tx: txRecord({ entity_id: "0.0.99999" }) }),
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("wrong_contract");
  });

  it("rejects the wrong function selector", async () => {
    const res = await claimPayment(
      { orderId: "ord1", txId: "0.0.999-1789000000-000000000" },
      {
        ...fastDeps,
        fetchFn: mockFetch({
          cr: contractResult({ function_parameters: "0xdeadbeef" + "00".repeat(96) }),
        }),
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("wrong_function");
  });

  it("rejects a payment to the wrong username (Brandon's rule)", async () => {
    const res = await claimPayment(
      { orderId: "ord1", txId: "0.0.999-1789000000-000000000" },
      {
        ...fastDeps,
        fetchFn: mockFetch({
          cr: contractResult({ function_parameters: tipCalldata("someone-else") }),
        }),
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("wrong_recipient");
    expect(getOrder("ord1")?.state).toBe("issued"); // never half-accepted
  });

  it("rejects undecodable tipPage calldata", async () => {
    const res = await claimPayment(
      { orderId: "ord1", txId: "0.0.999-1789000000-000000000" },
      {
        ...fastDeps,
        fetchFn: mockFetch({
          cr: contractResult({ function_parameters: "0x8b0de5cb" + "00".repeat(96) }),
        }),
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("wrong_recipient");
  });

  it("times out when the tx never appears on the mirror node", async () => {
    const res = await claimPayment(
      { orderId: "ord1", txId: "0.0.999-1789000000-000000000" },
      { ...fastDeps, fetchFn: mockFetch({ tx: null, cr: null }) },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("verification_timeout");
    expect(getOrder("ord1")?.state).toBe("issued"); // order survives, retryable
  });

  it("404s unknown orders", async () => {
    const res = await claimPayment(
      { orderId: "nope", txId: "0.0.999-1789000000-000000000" },
      { ...fastDeps, fetchFn: mockFetch() },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("order_not_found");
  });

  it("fails closed when the tips id is missing", async () => {
    const res = await claimPayment(
      { orderId: "ord1", txId: "0.0.999-1789000000-000000000" },
      { ...fastDeps, env: {}, fetchFn: mockFetch() },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("misconfigured");
  });

  it("fails closed when the recipient username is missing", async () => {
    const res = await claimPayment(
      { orderId: "ord1", txId: "0.0.999-1789000000-000000000" },
      {
        ...fastDeps,
        env: { A2A_TESTNET_TIPS_ID: TIPS },
        fetchFn: mockFetch(),
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("misconfigured");
  });
});
