/**
 * Order issuance tests for POST /api/a2a/orders.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueOrder } from "./orders";
import { __resetPaidStore, getOrder } from "./store";
import { PRICE_HBAR } from "./config";

const TIPS = "0.0.12345";
const ENV = { A2A_TESTNET_TIPS_ID: TIPS, A2A_RECIPIENT_USERNAME: "test-recipient" };

function mockFetch(balanceTinybar: bigint | null) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (String(url).includes("/accounts/")) {
      if (balanceTinybar === null) {
        return { status: 404, ok: false, json: async () => ({}) } as Response;
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({
          balance: { balance: balanceTinybar.toString() },
          deleted: false,
        }),
      } as Response;
    }
    throw new Error(`unexpected url ${url}`);
  });
}

beforeEach(() => {
  __resetPaidStore();
});

describe("issueOrder", () => {
  it("issues a bill with the order-bound memo (happy path)", async () => {
    const res = await issueOrder(
      { product: "chat-50", buyerAccount: "0.0.999" },
      {
        fetchFn: mockFetch(BigInt(10e8)),
        env: ENV,
        now: () => 1_000_000,
        orderId: () => "abc123",
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bill.orderId).toBe("abc123");
    expect(res.bill.priceHbar).toBe(PRICE_HBAR);
    expect(res.bill.payTo).toBe(TIPS);
    expect(res.bill.payToUsername).toBe("test-recipient");
    expect(res.bill.function).toBe("tipPage");
    expect(res.bill.memo).toBe("vs-order:abc123");
    expect(res.bill.expiresAt).toBe(1_000_000 + 15 * 60 * 1000);
    const stored = getOrder("abc123");
    expect(stored?.state).toBe("issued");
  });

  it("rejects unknown products", async () => {
    const res = await issueOrder(
      { product: "moon-lambo", buyerAccount: "0.0.999" },
      { fetchFn: mockFetch(BigInt(10e8)), env: ENV },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_product");
  });

  it("rejects malformed buyer accounts", async () => {
    const res = await issueOrder(
      { product: "chat-50", buyerAccount: "not-an-account" },
      { fetchFn: mockFetch(BigInt(10e8)), env: ENV },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("invalid_buyer_account");
  });

  it("rejects insufficient balance (price + fee buffer)", async () => {
    const res = await issueOrder(
      { product: "chat-50", buyerAccount: "0.0.999" },
      { fetchFn: mockFetch(BigInt(1e8)), env: ENV }, // 1 HBAR < 5.5
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("insufficient_balance");
  });

  it("rejects unknown accounts", async () => {
    const res = await issueOrder(
      { product: "blockpage-build", buyerAccount: "0.0.999" },
      { fetchFn: mockFetch(null), env: ENV },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("account_not_found");
  });

  it("fails closed when the tips id is missing", async () => {
    const res = await issueOrder(
      { product: "chat-50", buyerAccount: "0.0.999" },
      { fetchFn: mockFetch(BigInt(10e8)), env: {} },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("misconfigured");
  });
});
