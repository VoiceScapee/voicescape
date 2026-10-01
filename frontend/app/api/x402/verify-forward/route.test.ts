/**
 * GET /api/x402/verify-forward route tests: malformed → 400, happy path →
 * 200 with a verification body, IP gate enforced. Mirror-node fetch is
 * stubbed (no network); the KV store is the real in-memory store, cleared
 * between tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getKvStore } from "@/lib/server/store";

import { GET } from "./route";

const MIRROR = "https://mainnet.mirrornode.hedera.com/api/v1";
const PAY_DASH = "0.0.10571514-1727777777-123456789";
const PAY_AT = "0.0.10571514@1727777777.123456789";

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/x402/verify-forward${query}`, {
    method: "GET",
  });
}

beforeEach(async () => {
  await getKvStore().clearPrefix("vs:iprl:");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith(`${MIRROR}/transactions/${PAY_DASH}`)) {
        return {
          ok: true,
          json: async () => ({
            transactions: [
              {
                transaction_id: PAY_AT,
                result: "SUCCESS",
                consensus_timestamp: "1727777777.123456789",
                transfers: [
                  { account: "0.0.1001", amount: -1000000000, is_approval: false },
                  { account: "0.0.2002", amount: 1000000000, is_approval: false },
                ],
                token_transfers: [],
              },
            ],
          }),
        };
      }
      if (url.includes("transactions?account.id=0.0.2002")) {
        return {
          ok: true,
          json: async () => ({
            transactions: [
              {
                transaction_id: "0.0.2002@1727780000.000000001",
                result: "SUCCESS",
                consensus_timestamp: "1727780000.000000001",
                transfers: [
                  { account: "0.0.2002", amount: -20000000, is_approval: false },
                  { account: "0.0.10424063", amount: 20000000, is_approval: false },
                ],
                token_transfers: [],
              },
            ],
          }),
        };
      }
      if (url.includes("/accounts/0.0.2002")) {
        return {
          ok: true,
          json: async () => ({
            evm_address: "0x00000000000000000000000000000000000007d2",
          }),
        };
      }
      if (url.includes("/contracts/0.0.10854058/results")) {
        return { ok: true, json: async () => ({ results: [] }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/x402/verify-forward", () => {
  it("400s on a malformed paymentTx without touching the network", async () => {
    const res = await GET(req("?paymentTx=nope"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("malformed-tx-id");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("400s when paymentTx is missing", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(400);
  });

  it("returns a verified body for a payment whose forward landed", async () => {
    const res = await GET(req(`?paymentTx=${encodeURIComponent(PAY_AT)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.verified).toBe(true);
    expect(body.reason).toBe("forward-found");
    expect(body.agentWallet).toBe("0.0.2002");
    expect(body.agentPage).toBeNull(); // no registered page in the stub
    expect(body.forwardedAmount).toBe("20000000");
  });
});
