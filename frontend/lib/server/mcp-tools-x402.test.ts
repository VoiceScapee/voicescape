/**
 * Voicescape MCP x402 buyer tools — unit tests.
 *
 * The 402 endpoint is fully mocked (no network, no mainnet spend). The
 * facilitator is mocked too: "signing" in tests uses a throwaway
 * @hiero-ledger/sdk key whose signatures never leave the VM.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  PrivateKey,
  Transaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import {
  prepareX402PaymentTool,
  completeX402PaymentTool,
} from "./mcp-tools-x402";

const ENDPOINT = "https://agent.example.com/meme";
const BUYER = "0.0.777001";
const PAY_TO = "0.0.777002";
const FEE_PAYER = "0.0.777003";

function requirementsDoc(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    resource: { description: "Custom meme generator" },
    accepts: [
      {
        scheme: "exact",
        network: "hedera:mainnet",
        amount: "3000000", // 0.03 HBAR
        asset: "0.0.0", // HBAR
        payTo: PAY_TO,
        extra: { feePayer: FEE_PAYER },
        ...overrides,
      },
    ],
  };
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Mock fetch: 402s for the endpoint, ok for the mirror-node buyer check. */
function mock402(doc: unknown, buyerExists = true) {
  const payReq = b64url(doc);
  return vi.fn(async (input: any, init?: any) => {
    // wrapFetchWithPayment passes a Request object, not a URL string.
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    const headers = new Headers((init as { headers?: unknown } | undefined)?.headers as any);
    if (input?.headers) {
      for (const [k, v] of new Headers(input.headers as any)) headers.set(k, v);
    }
    if (url.startsWith("https://mainnet.mirrornode.hedera.com")) {
      return { ok: buyerExists, status: buyerExists ? 200 : 404 } as any;
    }
    if (headers.get("PAYMENT-SIGNATURE")) {
      // Paid retry: facilitator "settles" and serves the resource.
      const payRes = b64url({ success: true, transaction: "0.0.777003@1700000000.000000000", payer: BUYER });
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          "content-type": "application/json",
          "PAYMENT-RESPONSE": payRes,
        }),
        arrayBuffer: async () => Buffer.from(JSON.stringify({ meme_cid: "bafkreimeme" })),
      } as any;
    }
    return {
      ok: false,
      status: 402,
      headers: new Headers({ "PAYMENT-REQUIRED": payReq }),
      text: async () => "",
    } as any;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prepareX402PaymentTool", () => {
  it("probes the 402 terms and returns unsigned frozen transfer bytes", async () => {
    vi.stubGlobal("fetch", mock402(requirementsDoc()));
    const res = (await prepareX402PaymentTool({
      endpoint_url: ENDPOINT,
      buyer_account_id: BUYER,
    })) as any;
    expect(res.error).toBeUndefined();
    expect(res.rail.amount).toBe("3000000");
    expect(res.rail.pay_to).toBe(PAY_TO);
    expect(res.rail.fee_payer).toBe(FEE_PAYER);
    expect(res.rail.kind).toBe("HBAR");

    // Unsigned bytes decode to a frozen TransferTransaction with the
    // exact transfers, payer = feePayer, and no signatures applied.
    const tx = Transaction.fromBytes(Buffer.from(res.unsigned_tx_base64, "base64"));
    expect(tx).toBeInstanceOf(TransferTransaction);
    expect(tx.isFrozen()).toBe(true);
    expect(tx.transactionId?.accountId?.toString()).toBe(FEE_PAYER);
    const t = tx as TransferTransaction;
    const hbarXfers = (t as any).hbarTransfers as Map<string, any>;
    expect(hbarXfers.get(BUYER)?.toTinybars().toString()).toBe("-3000000");
    expect(hbarXfers.get(PAY_TO)?.toTinybars().toString()).toBe("3000000");
    expect(res.instructions).toMatch(/UNSIGNED/);
    expect(res.instructions).toMatch(/YOUR OWN Hedera key/);
  });

  it("prefers the HBAR rail when several are advertised", async () => {
    const doc = requirementsDoc();
    (doc.accepts as any[]).unshift({
      scheme: "exact",
      network: "hedera:mainnet",
      amount: "50000",
      asset: "0.0.456858", // USDC
      payTo: PAY_TO,
      extra: { feePayer: FEE_PAYER },
    });
    vi.stubGlobal("fetch", mock402(doc));
    const res = (await prepareX402PaymentTool({
      endpoint_url: ENDPOINT,
      buyer_account_id: BUYER,
    })) as any;
    expect(res.rail.kind).toBe("HBAR");
  });

  it("honors an explicit asset selector", async () => {
    const doc = requirementsDoc();
    (doc.accepts as any[]).unshift({
      scheme: "exact",
      network: "hedera:mainnet",
      amount: "50000",
      asset: "0.0.456858",
      payTo: PAY_TO,
      extra: { feePayer: FEE_PAYER },
    });
    vi.stubGlobal("fetch", mock402(doc));
    const res = (await prepareX402PaymentTool({
      endpoint_url: ENDPOINT,
      buyer_account_id: BUYER,
      asset: "0.0.456858",
    })) as any;
    expect(res.rail.asset).toBe("0.0.456858");
  });

  it("warns (not errors) when the buyer account does not exist yet", async () => {
    vi.stubGlobal("fetch", mock402(requirementsDoc(), false));
    const res = (await prepareX402PaymentTool({
      endpoint_url: ENDPOINT,
      buyer_account_id: BUYER,
    })) as any;
    expect(res.error).toBeUndefined();
    expect(res.buyer_account_exists).toBe(false);
    expect(res.instructions).toMatch(/hollow account/);
  });

  it("rejects non-URL endpoints and bad buyer accounts", async () => {
    const bad1 = await prepareX402PaymentTool({ endpoint_url: "not-a-url", buyer_account_id: BUYER });
    expect((bad1 as any).error).toMatch(/not an http/);
    const bad2 = await prepareX402PaymentTool({ endpoint_url: ENDPOINT, buyer_account_id: "bob" });
    expect((bad2 as any).error).toMatch(/not a 0\.0\.x account/);
  });

  it("errors when the endpoint does not 402", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => "" }) as any),
    );
    const res = await prepareX402PaymentTool({ endpoint_url: ENDPOINT, buyer_account_id: BUYER });
    expect((res as any).error).toMatch(/payment terms/);
  });
});

describe("completeX402PaymentTool", () => {
  async function preparedSigned(): Promise<{ prepared: any; signedB64: string }> {
    vi.stubGlobal("fetch", mock402(requirementsDoc()));
    const prepared = (await prepareX402PaymentTool({
      endpoint_url: ENDPOINT,
      buyer_account_id: BUYER,
    })) as any;
    const tx = Transaction.fromBytes(Buffer.from(prepared.unsigned_tx_base64, "base64"));
    const key = PrivateKey.generateED25519();
    const signed = await tx.sign(key);
    return { prepared, signedB64: Buffer.from(signed.toBytes()).toString("base64") };
  }

  it("completes the 402 handshake and returns the service response + settle receipt", async () => {
    const { prepared, signedB64 } = await preparedSigned();
    vi.stubGlobal("fetch", mock402(requirementsDoc()));
    const res = (await completeX402PaymentTool({
      endpoint_url: ENDPOINT,
      signed_tx_base64: signedB64,
      buyer_account_id: BUYER,
      expected_network: prepared.rail.network,
      expected_asset: prepared.rail.asset,
      expected_amount: prepared.rail.amount,
      expected_pay_to: prepared.rail.pay_to,
      expected_fee_payer: prepared.rail.fee_payer,
      request_body: JSON.stringify({ prompt: "a cat in a spacesuit" }),
    })) as any;
    expect(res.error).toBeUndefined();
    expect(res.http_status).toBe(200);
    expect(res.settle_tx_id).toBe("0.0.777003@1700000000.000000000");
    expect(res.settle_tx_hashscan).toContain("hashscan.io");
    expect(res.response_text ?? res.response_base64).toBeTruthy();
  });

  it("aborts when the live terms changed since prepare", async () => {
    const { prepared, signedB64 } = await preparedSigned();
    // Endpoint reprices between prepare and complete.
    vi.stubGlobal("fetch", mock402(requirementsDoc({ amount: "9000000" })));
    const res = await completeX402PaymentTool({
      endpoint_url: ENDPOINT,
      signed_tx_base64: signedB64,
      buyer_account_id: BUYER,
      expected_network: prepared.rail.network,
      expected_asset: prepared.rail.asset,
      expected_amount: prepared.rail.amount,
      expected_pay_to: prepared.rail.pay_to,
      expected_fee_payer: prepared.rail.fee_payer,
    });
    expect((res as any).error).toMatch(/changed since prepare/);
  });

  it("rejects undecodable signed bytes", async () => {
    const res = await completeX402PaymentTool({
      endpoint_url: ENDPOINT,
      signed_tx_base64: "aGVsbG8td29ybGQ=",
      buyer_account_id: BUYER,
      expected_network: "hedera:mainnet",
      expected_asset: "0.0.0",
      expected_amount: "3000000",
      expected_pay_to: PAY_TO,
      expected_fee_payer: FEE_PAYER,
    });
    expect((res as any).error).toMatch(/decodable|TransferTransaction/);
  });
});
