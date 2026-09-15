/**
 * HTTP-level tests for POST /api/a2a/orders and POST /api/a2a/paid.
 * Exercises both routes together: issue a bill, then claim it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getKvStore } from "@/lib/server/store";
import { __resetPaidStore } from "@/lib/server/a2a-paid/store";

import { POST as ordersPOST } from "./orders/route";
import { POST as paidPOST } from "./paid/route";

const TIPS = "0.0.12345";
const TIPS_LONG_ZERO = "0x0000000000000000000000000000000000003039";
const RECIPIENT = "test-recipient";

/** Build real tipPage(string) calldata for a username (selector + ABI string). */
function tipCalldata(username: string): string {
  const data = Buffer.from(username, "utf8");
  const offsetWord = "0".repeat(62) + "20"; // 32
  const lenWord = data.length.toString(16).padStart(64, "0");
  const paddedLen = Math.ceil(data.length / 32) * 32;
  const dataPadded = data.toString("hex").padEnd(paddedLen * 2, "0");
  return "0x8b0de5cb" + offsetWord + lenWord + dataPadded;
}

function req(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** Mirror fetch mock; the tx memo is bound to the issued orderId. */
let currentMemo = "";
function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes("/accounts/")) {
      return {
        status: 200,
        ok: true,
        json: async () => ({ balance: { balance: String(10e8) }, deleted: false }),
      } as Response;
    }
    if (u.includes("/contracts/results/")) {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          status: "0x1",
          to: TIPS_LONG_ZERO,
          amount: String(5e8),
          function_parameters: tipCalldata(RECIPIENT),
          contract_id: TIPS,
        }),
      } as Response;
    }
    if (u.includes("/transactions/")) {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          transactions: [
            {
              result: "SUCCESS",
              entity_id: TIPS,
              memo_base64: b64(currentMemo),
              transaction_id: "0.0.999-1789000000-000000000",
            },
          ],
        }),
      } as Response;
    }
    throw new Error(`unexpected url ${u}`);
  });
}

beforeEach(async () => {
  await getKvStore().clearPrefix("vs:iprl:");
  __resetPaidStore();
  currentMemo = "";
  vi.stubEnv("A2A_TESTNET_TIPS_ID", TIPS);
  vi.stubEnv("A2A_RECIPIENT_USERNAME", RECIPIENT);
  vi.stubEnv("IP_RATE_LIMIT_A2A_ORDERS", "60");
  vi.stubEnv("IP_RATE_LIMIT_A2A_PAID", "60");
  vi.stubGlobal("fetch", mockFetch());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/a2a/orders", () => {
  it("returns 402 with the bill for a valid request", async () => {
    const res = await ordersPOST(
      req("/api/a2a/orders", { product: "chat-50", buyerAccount: "0.0.999" }),
    );
    expect(res.status).toBe(402);
    const bill = await res.json();
    expect(bill.priceHbar).toBe(5);
    expect(bill.payTo).toBe(TIPS);
    expect(bill.payToUsername).toBe(RECIPIENT);
    expect(bill.function).toBe("tipPage");
    expect(bill.memo).toBe(`vs-order:${bill.orderId}`);
  });

  it("400s an unknown product", async () => {
    const res = await ordersPOST(
      req("/api/a2a/orders", { product: "nope", buyerAccount: "0.0.999" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/a2a/paid", () => {
  it("full flow: order → pay (mocked mirror) → entitlement, then double-claim 409s", async () => {
    const orderRes = await ordersPOST(
      req("/api/a2a/orders", { product: "blockpage-build", buyerAccount: "0.0.999" }),
    );
    expect(orderRes.status).toBe(402);
    const bill = await orderRes.json();
    currentMemo = bill.memo;

    const txId = "0.0.999-1789000000-000000000";
    const paidRes = await paidPOST(req("/api/a2a/paid", { orderId: bill.orderId, txId }));
    expect(paidRes.status).toBe(200);
    const body = await paidRes.json();
    expect(body.entitlement.orderId).toBe(bill.orderId);
    expect(body.entitlement.product).toBe("blockpage-build");
    expect(body.entitlement.txId).toBe(txId);

    const again = await paidPOST(req("/api/a2a/paid", { orderId: bill.orderId, txId }));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("already_claimed");
  });

  it("422s when the memo does not bind the order", async () => {
    const orderRes = await ordersPOST(
      req("/api/a2a/orders", { product: "chat-50", buyerAccount: "0.0.999" }),
    );
    const bill = await orderRes.json();
    currentMemo = "vs-order:someone-elses-order";
    const res = await paidPOST(
      req("/api/a2a/paid", { orderId: bill.orderId, txId: "0.0.999-1-1" }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("memo_mismatch");
  });

  it("404s unknown orders", async () => {
    const res = await paidPOST(
      req("/api/a2a/paid", { orderId: "nope", txId: "0.0.999-1-1" }),
    );
    expect(res.status).toBe(404);
  });
});
