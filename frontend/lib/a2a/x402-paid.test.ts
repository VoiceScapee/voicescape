/**
 * x402 paid-endpoint tests for danny's POST /api/a2a/paid.
 *
 * Covers the money logic with pure unit tests (price math, 402 document,
 * config fail-fast, payload matching) and the verify->settle flow with a
 * stubbed facilitator — no network, no secrets, no real money.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import {
  buildPaymentRequired,
  DANNY_ACCOUNT_ID,
  decodePaymentSignature,
  encodePaymentRequired,
  EXACT_SCHEME,
  findMatchingRequirements,
  getPaidEndpointConfig,
  HBAR_ASSET_ID,
  MIN_PRICE_USD_CENTS,
  PaidRequestError,
  parseHbarUsdPrice,
  paymentResourceMatches,
  TESTNET_FACILITATOR_URL,
  TESTNET_FEE_PAYER_ACCOUNT,
  USDC_MAINNET_TOKEN_ID,
  USDC_TESTNET_TOKEN_ID,
  usdCentsToTinybars,
  usdCentsToUsdcBaseUnits,
  verifyAndSettle,
  X402_VERSION,
} from "./x402-paid";

const here = dirname(fileURLToPath(import.meta.url));
const routeSrc = readFileSync(join(here, "..", "..", "app", "api", "a2a", "paid", "route.ts"), "utf8");

const TESTNET_ENV = {
  DANNY_X402_NETWORK: "testnet",
  DANNY_X402_PRICE_USD_CENTS: "1",
  DANNY_X402_HBAR_USD_PRICE: "0.20",
};

const RESOURCE = "https://voicescape.vercel.app/api/a2a/paid";

function testnetConfig() {
  return getPaidEndpointConfig({ ...process.env, ...TESTNET_ENV });
}

function sigHeader(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function paidPayload(overrides: Partial<PaymentPayload> = {}): PaymentPayload {
  return {
    x402Version: X402_VERSION,
    resource: { url: RESOURCE },
    accepted: {
      scheme: EXACT_SCHEME,
      network: "hedera:testnet",
      asset: HBAR_ASSET_ID,
      amount: "5000000",
      payTo: DANNY_ACCOUNT_ID,
      maxTimeoutSeconds: 180,
      extra: {},
    },
    payload: { transaction: "deadbeef" },
    ...overrides,
  };
}

describe("price math (exact BigInt, proven formulas)", () => {
  it("converts 1¢ to 10,000 USDC base units", () => {
    expect(usdCentsToUsdcBaseUnits(1n)).toBe(10_000n);
  });

  it("converts 25¢ to 250,000 USDC base units", () => {
    expect(usdCentsToUsdcBaseUnits(25n)).toBe(250_000n);
  });

  it("converts 1¢ to 5,000,000 tinybars at $0.20/HBAR", () => {
    expect(usdCentsToTinybars(1n, { num: 20n, den: 100n })).toBe(5_000_000n);
  });

  it("rounds UP to whole tinybars so danny is never shorted", () => {
    // 1¢ at $0.30/HBAR = 3,333,333.33… tinybars -> ceil to 3,333,334
    expect(usdCentsToTinybars(1n, { num: 30n, den: 100n })).toBe(3_333_334n);
  });

  it("rejects negative prices and non-positive rates", () => {
    expect(() => usdCentsToTinybars(-1n, { num: 20n, den: 100n })).toThrow();
    expect(() => usdCentsToTinybars(1n, { num: 0n, den: 100n })).toThrow();
    expect(() => usdCentsToUsdcBaseUnits(-1n)).toThrow();
  });

  it("parses HBAR/USD rates exactly, rejects garbage", () => {
    expect(parseHbarUsdPrice("0.20")).toEqual({ num: 20n, den: 100n });
    expect(parseHbarUsdPrice("1")).toEqual({ num: 1n, den: 1n });
    expect(() => parseHbarUsdPrice("zero")).toThrow();
    expect(() => parseHbarUsdPrice("0")).toThrow();
  });
});

describe("config (fail-fast)", () => {
  it("defaults to testnet with the proven Blocky402 facilitator", () => {
    const c = testnetConfig();
    expect(c.networkId).toBe("hedera:testnet");
    expect(c.facilitatorUrl).toBe(TESTNET_FACILITATOR_URL);
    expect(c.feePayerAccount).toBe(TESTNET_FEE_PAYER_ACCOUNT);
    expect(c.payTo).toBe(DANNY_ACCOUNT_ID);
    expect(c.priceUsdCents).toBe(1n);
    expect(c.priceTinybars).toBe("5000000");
    expect(c.priceUsdcBaseUnits).toBe("10000");
    expect(c.usdcAssetId).toBe(USDC_TESTNET_TOKEN_ID);
  });

  it("refuses mainnet without an explicit facilitator (no silent wrong-network settle)", () => {
    expect(() =>
      getPaidEndpointConfig({ DANNY_X402_NETWORK: "mainnet" }),
    ).toThrow(/DANNY_X402_FACILITATOR_URL/);
  });

  it("accepts mainnet with explicit facilitator + fee payer, picks mainnet USDC", () => {
    const c = getPaidEndpointConfig({
      DANNY_X402_NETWORK: "mainnet",
      DANNY_X402_FACILITATOR_URL: "https://facilitator.example",
      DANNY_X402_FEE_PAYER_ACCOUNT: "0.0.999999",
    });
    expect(c.networkId).toBe("hedera:mainnet");
    expect(c.usdcAssetId).toBe(USDC_MAINNET_TOKEN_ID);
  });

  it("refuses to boot below the 1¢ dust floor (economics invariant)", () => {
    expect(() =>
      getPaidEndpointConfig({ ...TESTNET_ENV, DANNY_X402_PRICE_USD_CENTS: "0" }),
    ).toThrow(/dust floor/);
    expect(MIN_PRICE_USD_CENTS).toBe(1n);
  });

  it("rejects garbage network names and pay-to accounts", () => {
    expect(() =>
      getPaidEndpointConfig({ DANNY_X402_NETWORK: "ethereum" }),
    ).toThrow(/DANNY_X402_NETWORK/);
    expect(() =>
      getPaidEndpointConfig({ ...TESTNET_ENV, DANNY_X402_PAY_TO: "not-an-account" }),
    ).toThrow(/DANNY_X402_PAY_TO/);
  });
});

describe("402 price menu", () => {
  it("advertises HBAR + USDC rails from the same USD quote", () => {
    const doc = buildPaymentRequired(testnetConfig(), RESOURCE);
    expect(doc.x402Version).toBe(2);
    expect(doc.resource.url).toBe(RESOURCE);
    expect(doc.accepts).toHaveLength(2);
    const hbar = doc.accepts.find((r) => r.asset === HBAR_ASSET_ID)!;
    const usdc = doc.accepts.find((r) => r.asset === USDC_TESTNET_TOKEN_ID)!;
    expect(hbar.amount).toBe("5000000"); // 0.05 HBAR at $0.20
    expect(usdc.amount).toBe("10000"); // 0.01 USDC
    for (const r of doc.accepts) {
      expect(r.scheme).toBe("exact");
      expect(r.network).toBe("hedera:testnet");
      expect(r.payTo).toBe(DANNY_ACCOUNT_ID);
      expect(r.extra.feePayer).toBe(TESTNET_FEE_PAYER_ACCOUNT);
      expect(r.extra.paymentFlow).toBe("upfront");
    }
  });

  it("base64-encodes the 402 document for the PAYMENT-REQUIRED header", () => {
    const doc = buildPaymentRequired(testnetConfig(), RESOURCE);
    const decoded = JSON.parse(Buffer.from(encodePaymentRequired(doc), "base64").toString("utf8"));
    expect(decoded.accepts).toHaveLength(2);
    expect(decoded.resource.url).toBe(RESOURCE);
  });
});

describe("payment payload handling", () => {
  it("decodes a valid PAYMENT-SIGNATURE, rejects garbage", () => {
    const p = decodePaymentSignature(sigHeader(paidPayload()));
    expect(p.accepted.payTo).toBe(DANNY_ACCOUNT_ID);
    expect(() => decodePaymentSignature("!!!not-base64!!!")).toThrow(PaidRequestError);
    expect(() => decodePaymentSignature(sigHeader({ nope: true }))).toThrow(PaidRequestError);
  });

  it("enforces replay hygiene on the resource URL", () => {
    expect(paymentResourceMatches(paidPayload(), RESOURCE)).toBe(true);
    expect(
      paymentResourceMatches(paidPayload({ resource: { url: "https://evil.example/paid" } }), RESOURCE),
    ).toBe(false);
    expect(paymentResourceMatches(paidPayload({ resource: undefined }), RESOURCE)).toBe(false);
  });

  it("matches the payload against advertised terms exactly", () => {
    const advertised = buildPaymentRequired(testnetConfig(), RESOURCE).accepts;
    const hit = findMatchingRequirements(paidPayload(), advertised);
    expect(hit).not.toBeNull();
    expect(hit!.amount).toBe("5000000");
    // Wrong amount -> no match (buyer can't underpay)
    expect(
      findMatchingRequirements(
        paidPayload({ accepted: { ...paidPayload().accepted, amount: "1" } }),
        advertised,
      ),
    ).toBeNull();
    // Wrong asset -> no match
    expect(
      findMatchingRequirements(
        paidPayload({ accepted: { ...paidPayload().accepted, asset: "0.0.12345" } }),
        advertised,
      ),
    ).toBeNull();
    // USDC rail matches too
    const usdcPayload = paidPayload({
      accepted: {
        scheme: EXACT_SCHEME,
        network: "hedera:testnet",
        asset: USDC_TESTNET_TOKEN_ID,
        amount: "10000",
        payTo: DANNY_ACCOUNT_ID,
        maxTimeoutSeconds: 180,
        extra: {},
      },
    });
    expect(findMatchingRequirements(usdcPayload, advertised)).not.toBeNull();
  });
});

describe("verifyAndSettle (stubbed facilitator)", () => {
  const reqs = buildPaymentRequired(testnetConfig(), RESOURCE).accepts[0];
  const receipt: SettleResponse = {
    success: true,
    transaction: "0.0.10857765@1234567890.000000000",
    network: "hedera:testnet",
  };
  const okFacilitator = {
    verify: async () => ({ isValid: true, payer: "0.0.111111" }),
    settle: async () => receipt,
  };

  it("settles after a valid verification and returns the receipt", async () => {
    const out = await verifyAndSettle(okFacilitator, paidPayload(), reqs);
    expect(out.transaction).toBe(receipt.transaction);
  });

  it("rejects invalid payments with 402 (buyer can retry)", async () => {
    const bad = {
      verify: async () => ({ isValid: false, invalidReason: "bad signature" }),
      settle: async () => receipt,
    };
    await expect(verifyAndSettle(bad, paidPayload(), reqs)).rejects.toMatchObject({
      status: 402,
    });
  });

  it("fails closed with 502 when verification errors", async () => {
    const broken = {
      verify: async () => {
        throw new Error("facilitator down");
      },
      settle: async () => receipt,
    };
    await expect(verifyAndSettle(broken, paidPayload(), reqs)).rejects.toMatchObject({
      status: 502,
    });
  });

  it("fails closed with 502 when settlement fails or errors", async () => {
    const noSettle = {
      verify: async () => ({ isValid: true }),
      settle: async () => ({ ...receipt, success: false, errorReason: "timeout" }),
    };
    await expect(verifyAndSettle(noSettle, paidPayload(), reqs)).rejects.toMatchObject({
      status: 502,
    });
    const settleThrows = {
      verify: async () => ({ isValid: true }),
      settle: async () => {
        throw new Error("boom");
      },
    };
    await expect(verifyAndSettle(settleThrows, paidPayload(), reqs)).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe("route wiring (source assertions, repo convention)", () => {
  it("402s unpaid requests with the PAYMENT-REQUIRED header", () => {
    expect(routeSrc).toContain("PAYMENT-SIGNATURE");
    expect(routeSrc).toContain("status: 402");
    expect(routeSrc).toContain('"PAYMENT-REQUIRED"');
    expect(routeSrc).toContain("encodePaymentRequired");
  });

  it("fails closed with 503 when x402 is misconfigured (never 402s blind)", () => {
    expect(routeSrc).toContain("getPaidEndpointConfig()");
    expect(routeSrc).toContain("status: 503");
    expect(routeSrc).toContain("No payment was requested or settled");
  });

  it("serves the same Q&A brain as the free endpoint after settlement", () => {
    expect(routeSrc).toContain("answerMessage(params)");
    expect(routeSrc).toContain('from "@/lib/a2a/handler"');
  });

  it("returns the settle receipt in PAYMENT-RESPONSE", () => {
    expect(routeSrc).toContain('"PAYMENT-RESPONSE"');
    expect(routeSrc).toContain("encodePaymentResponse(receipt)");
  });

  it("only sells answers: non-SendMessage methods get a protocol error, no charge", () => {
    expect(routeSrc).toContain('new Set(["SendMessage", "message/send"])');
    expect(routeSrc).toContain("only SendMessage (message/send)");
  });

  it("enforces replay hygiene and exact-terms matching", () => {
    expect(routeSrc).toContain("paymentResourceMatches(payload, resource)");
    expect(routeSrc).toContain("findMatchingRequirements(payload, advertised)");
  });

  it("rate-limits like the free endpoint and runs on nodejs (Buffer)", () => {
    expect(routeSrc).toContain('ipGate(');
    expect(routeSrc).toContain('"a2a-paid"');
    expect(routeSrc).toContain('runtime = "nodejs"');
  });
});
