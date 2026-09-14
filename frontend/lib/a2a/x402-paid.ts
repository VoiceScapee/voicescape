/**
 * Paid x402 endpoint logic for danny (Voicescape's agent liaison, Hedera
 * account 0.0.10857765).
 *
 * POST /api/a2a/paid serves the SAME onboarding Q&A brain as the free
 * POST /api/a2a (lib/a2a/handler.ts) — but behind an x402 paywall: an agent
 * pays a dust-level amount (HBAR or USDC rail, USD-quoted) and gets the
 * full onboarding answer. No API keys, no accounts — the 402 handshake.
 *
 * Pattern provenance: this follows the proven x402-vibecode service
 * (VoiceScapee/x402-vibecode) — @x402/core HTTPFacilitatorClient for
 * verify/settle, the "exact" scheme, feePayer-as-payer partial transfers,
 * paymentFlow "upfront" (settle BEFORE serving), and the same wire shapes:
 *   - 402 out: PAYMENT-REQUIRED: base64({ x402Version: 2, resource, accepts })
 *   - buyer in: PAYMENT-SIGNATURE: base64(PaymentPayload)
 *   - 200 out: PAYMENT-RESPONSE: base64(SettleResponse)
 *
 * What this module does NOT do (honest limits):
 *   - It cannot settle real payments without a configured facilitator.
 *     Mainnet has NO default facilitator: without DANNY_X402_FACILITATOR_URL
 *     the endpoint fails CLOSED (503, never 402s for a payment it cannot
 *     settle). Testnet defaults to Blocky402's open testnet facilitator,
 *     exactly like the proven service.
 *   - Treasury forwarding is SKIPPED by the proven skip rule: at dust
 *     prices the 2% share is worth far less than 2x the forward tx fee, so
 *     danny keeps 100% of each dust payment. No HCS audit feed either
 *     (no audit topic is configured for danny).
 *
 * Economics invariant ("the platform never loses money"): danny's marginal
 * cost per paid request is ~$0 — the answer is deterministic (no AI call),
 * the facilitator's fee payer bears the settle tx fee, and we perform no
 * chain writes. The price floor is therefore a 1-cent dust minimum: the
 * endpoint refuses to boot below 1¢ so it can never be free-by-accident.
 */

import { HTTPFacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Minimal env shape the config readers need (real process.env or a test stub). */
export type EnvLike = Record<string, string | undefined>;

/** danny — the account receiving paid-endpoint payments. */
export const DANNY_ACCOUNT_ID = "0.0.10857765";

/** x402 asset id for native HBAR. */
export const HBAR_ASSET_ID = "0.0.0";

/** USDC on Hedera mainnet (6 decimals). */
export const USDC_MAINNET_TOKEN_ID = "0.0.456858";

/** USDC on Hedera testnet (6 decimals). */
export const USDC_TESTNET_TOKEN_ID = "0.0.429274";

/** USDC decimals on Hedera (both networks). */
export const USDC_DECIMALS = 6;

/** Tinybars per HBAR. */
export const TINYBARS_PER_HBAR = 100_000_000n;

/** x402 "exact" scheme name. */
export const EXACT_SCHEME = "exact";

/** x402 protocol version on the wire. */
export const X402_VERSION = 2;

/**
 * Dust price floor in USD cents. The endpoint refuses to boot below this:
 * selling below 1¢ is never worth the 402 machinery, and the free
 * /api/a2a already answers the same questions for free.
 */
export const MIN_PRICE_USD_CENTS = 1n;

/** Default price: 1¢/request (dust-level). */
export const DEFAULT_PRICE_USD_CENTS = 1n;

/** Default HBAR/USD rate for the HBAR-rail conversion (operator override). */
export const DEFAULT_HBAR_USD_PRICE = "0.20";

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

export type PaidNetworkName = "testnet" | "mainnet" | "previewnet";

export function hederaNetworkName(env?: EnvLike): PaidNetworkName {
  const raw = (env ?? process.env).DANNY_X402_NETWORK?.trim() || "testnet";
  if (raw === "testnet" || raw === "mainnet" || raw === "previewnet") return raw;
  throw new Error(
    `DANNY_X402_NETWORK must be one of testnet|mainnet|previewnet (got "${raw}") — ` +
      `refusing to guess which network real money moves on.`,
  );
}

export function hederaNetworkId(name: PaidNetworkName): `hedera:${PaidNetworkName}` {
  return `hedera:${name}`;
}

/** USDC token id for the network. Throws for unknown networks. */
export function usdcAssetIdForNetwork(networkId: string): string {
  if (networkId === "hedera:testnet") return USDC_TESTNET_TOKEN_ID;
  if (networkId === "hedera:mainnet") return USDC_MAINNET_TOKEN_ID;
  if (networkId === "hedera:previewnet") {
    throw new Error(
      "usdcAssetIdForNetwork: no known USDC token id on previewnet — set DANNY_X402_NETWORK to testnet or mainnet.",
    );
  }
  throw new Error(`usdcAssetIdForNetwork: no USDC token id for network "${networkId}"`);
}

/* ------------------------------------------------------------------ */
/* Facilitator                                                         */
/* ------------------------------------------------------------------ */

/** Blocky402's open testnet facilitator. Only valid on testnet. */
export const TESTNET_FACILITATOR_URL = "https://api.testnet.blocky402.com";

/** Blocky402's testnet fee-payer account. Only valid on testnet. */
export const TESTNET_FEE_PAYER_ACCOUNT = "0.0.7162784";

/**
 * Facilitator URL. Explicit DANNY_X402_FACILITATOR_URL wins; testnet
 * defaults to Blocky402's open facilitator (proven default); mainnet and
 * previewnet have NO default and throw LOUDLY instead of silently
 * verifying through the wrong network's facilitator.
 */
export function getFacilitatorUrl(env?: EnvLike): string {
  const e = env ?? process.env;
  const explicit = e.DANNY_X402_FACILITATOR_URL?.trim();
  if (explicit) return explicit;
  if (hederaNetworkName(e) === "testnet") return TESTNET_FACILITATOR_URL;
  throw new Error(
    "DANNY_X402_FACILITATOR_URL is not set and there is no default x402 " +
      `facilitator for DANNY_X402_NETWORK="${e.DANNY_X402_NETWORK}". ` +
      "Set DANNY_X402_FACILITATOR_URL to a facilitator for that network " +
      "before taking payments — the endpoint will stay down (503) until then.",
  );
}

/**
 * Fee-payer account the buyer's partial transfer is frozen with (the
 * facilitator co-signs and submits). Same fail-fast rules as the URL.
 */
export function getFeePayerAccount(env?: EnvLike): string {
  const e = env ?? process.env;
  const explicit = e.DANNY_X402_FEE_PAYER_ACCOUNT?.trim();
  if (explicit) return explicit;
  if (hederaNetworkName(e) === "testnet") return TESTNET_FEE_PAYER_ACCOUNT;
  throw new Error(
    "DANNY_X402_FEE_PAYER_ACCOUNT is not set and there is no default fee " +
      "payer for this network. Set it to the facilitator's fee-payer account.",
  );
}

/** Optional facilitator API key (Blocky402 mainnet requires X-Api-Key). Never logged. */
export function getFacilitatorApiKey(env?: EnvLike): string | null {
  const key = (env ?? process.env).DANNY_X402_FACILITATOR_API_KEY?.trim();
  return key ? key : null;
}

/* ------------------------------------------------------------------ */
/* Price                                                               */
/* ------------------------------------------------------------------ */

export function getPriceUsdCents(env?: EnvLike): bigint {
  const raw = (env ?? process.env).DANNY_X402_PRICE_USD_CENTS ?? String(DEFAULT_PRICE_USD_CENTS);
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`DANNY_X402_PRICE_USD_CENTS must be a non-negative integer (got "${raw}")`);
  }
  return BigInt(raw.trim());
}

/** Parse a "0.20"-style USD price into an exact { num, den } rational. */
export function parseHbarUsdPrice(raw: string): { num: bigint; den: bigint } {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) throw new Error(`HBAR/USD price must be a positive decimal (got "${raw}")`);
  const num = BigInt(m[1] + (m[2] ?? ""));
  const den = 10n ** BigInt((m[2] ?? "").length);
  if (num <= 0n) throw new Error(`HBAR/USD price must be positive (got "${raw}")`);
  return { num, den };
}

export function getHbarUsdPrice(env?: EnvLike): { num: bigint; den: bigint } {
  const raw = (env ?? process.env).DANNY_X402_HBAR_USD_PRICE ?? DEFAULT_HBAR_USD_PRICE;
  try {
    return parseHbarUsdPrice(raw);
  } catch {
    throw new Error(`DANNY_X402_HBAR_USD_PRICE must be a positive decimal number (got "${raw}")`);
  }
}

/**
 * USD cents -> USDC base units. 1¢ = 10_000 base units (6 decimals).
 * Exact integer math.
 */
export function usdCentsToUsdcBaseUnits(usdCents: bigint): bigint {
  if (usdCents < 0n) throw new Error("usdCentsToUsdcBaseUnits: price cannot be negative");
  return (usdCents * 10n ** BigInt(USDC_DECIMALS)) / 100n;
}

/**
 * USD cents -> tinybars at the HBAR/USD rate, rounding UP so danny is
 * never shorted by the conversion. Exact BigInt math:
 *   ceil(usdCents * den * 1e8 / (100 * num))
 */
export function usdCentsToTinybars(
  usdCents: bigint,
  rate: { num: bigint; den: bigint },
): bigint {
  if (usdCents < 0n) throw new Error("usdCentsToTinybars: price cannot be negative");
  if (rate.num <= 0n || rate.den <= 0n) throw new Error("usdCentsToTinybars: rate must be positive");
  const a = usdCents * rate.den * TINYBARS_PER_HBAR;
  const b = 100n * rate.num;
  return (a + b - 1n) / b; // integer ceil
}

/** Pay-to account: danny's wallet. Env-overridable, validated. */
export function getPayToAccount(env?: EnvLike): string {
  const id = (env ?? process.env).DANNY_X402_PAY_TO?.trim() || DANNY_ACCOUNT_ID;
  if (!/^\d+\.\d+\.\d+$/.test(id)) {
    throw new Error(`DANNY_X402_PAY_TO must be a Hedera account id like 0.0.12345 (got "${id}")`);
  }
  return id;
}

/* ------------------------------------------------------------------ */
/* Config (fail-fast)                                                  */
/* ------------------------------------------------------------------ */

export interface PaidEndpointConfig {
  networkName: PaidNetworkName;
  networkId: `hedera:${PaidNetworkName}`;
  facilitatorUrl: string;
  feePayerAccount: string;
  facilitatorApiKey: string | null;
  payTo: string;
  priceUsdCents: bigint;
  priceTinybars: string;
  priceUsdcBaseUnits: string;
  usdcAssetId: string;
}

/**
 * Resolve and validate the paid-endpoint config. THROWS loudly on any
 * misconfiguration — including a price below the 1¢ dust floor (the
 * economics invariant: never sell below cost). The route catches this and
 * fails closed with 503 rather than 402ing for payments it cannot settle.
 */
export function getPaidEndpointConfig(env?: EnvLike): PaidEndpointConfig {
  const e = env ?? process.env;
  const networkName = hederaNetworkName(e);
  const networkId = hederaNetworkId(networkName);
  const facilitatorUrl = getFacilitatorUrl(e); // throws on mainnet w/o explicit URL
  const feePayerAccount = getFeePayerAccount(e);
  const priceUsdCents = getPriceUsdCents(e);
  if (priceUsdCents < MIN_PRICE_USD_CENTS) {
    throw new Error(
      `[economics] REFUSING TO BOOT: DANNY_X402_PRICE_USD_CENTS=${priceUsdCents}¢ is ` +
        `below the dust floor of ${MIN_PRICE_USD_CENTS}¢/request. Raise the price ` +
        `or unset the override (default ${DEFAULT_PRICE_USD_CENTS}¢).`,
    );
  }
  const rate = getHbarUsdPrice(e);
  return {
    networkName,
    networkId,
    facilitatorUrl,
    feePayerAccount,
    facilitatorApiKey: getFacilitatorApiKey(e),
    payTo: getPayToAccount(e),
    priceUsdCents,
    priceTinybars: usdCentsToTinybars(priceUsdCents, rate).toString(),
    priceUsdcBaseUnits: usdCentsToUsdcBaseUnits(priceUsdCents).toString(),
    usdcAssetId: usdcAssetIdForNetwork(networkId),
  };
}

/* ------------------------------------------------------------------ */
/* 402 document                                                        */
/* ------------------------------------------------------------------ */

export const PAID_DESCRIPTION =
  "danny's paid onboarding Q&A (Voicescape agent liaison). POST an A2A " +
  "SendMessage JSON-RPC request; pay the dust-level x402 price on the HBAR " +
  "or USDC rail and get the full onboarding answer — same brain as the free " +
  "POST /api/a2a. Buyer keys must be ECDSA (secp256k1).";

/**
 * Build the 402 PAYMENT-REQUIRED document: HBAR + USDC rails priced from
 * the same USD quote, paymentFlow "upfront" (verify -> settle -> serve),
 * feePayer so the buyer's SDK freezes the partial transfer correctly.
 */
export function buildPaymentRequired(
  config: PaidEndpointConfig,
  resourceUrl: string,
): PaymentRequired {
  const extra = {
    feePayer: config.feePayerAccount,
    paymentFlow: "upfront",
    buyerKeyType: "ECDSA (secp256k1)",
  };
  return {
    x402Version: X402_VERSION,
    resource: {
      url: resourceUrl,
      description: PAID_DESCRIPTION,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: EXACT_SCHEME,
        network: config.networkId,
        asset: HBAR_ASSET_ID,
        amount: config.priceTinybars,
        payTo: config.payTo,
        maxTimeoutSeconds: 180,
        extra,
      },
      {
        scheme: EXACT_SCHEME,
        network: config.networkId,
        asset: config.usdcAssetId,
        amount: config.priceUsdcBaseUnits,
        payTo: config.payTo,
        maxTimeoutSeconds: 180,
        extra,
      },
    ],
  };
}

export function encodePaymentRequired(doc: PaymentRequired): string {
  return Buffer.from(JSON.stringify(doc), "utf8").toString("base64");
}

export function encodePaymentResponse(receipt: SettleResponse): string {
  return Buffer.from(JSON.stringify(receipt), "utf8").toString("base64");
}

/* ------------------------------------------------------------------ */
/* Payment verification (verify -> settle, then serve)                  */
/* ------------------------------------------------------------------ */

/** Decode the buyer's PAYMENT-SIGNATURE header. Throws on garbage. */
export function decodePaymentSignature(header: string): PaymentPayload {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new PaidRequestError(400, "Could not decode PAYMENT-SIGNATURE header.");
  }
  if (!json || typeof json !== "object" || typeof (json as PaymentPayload).accepted !== "object") {
    throw new PaidRequestError(400, "PAYMENT-SIGNATURE is not a valid x402 payment payload.");
  }
  return json as PaymentPayload;
}

/**
 * Replay hygiene: the payload the buyer signed commits to a resource URL.
 * Only honor payments minted for THIS endpoint.
 */
export function paymentResourceMatches(payload: PaymentPayload, expectedUrl: string): boolean {
  const url = payload.resource?.url;
  return typeof url === "string" && url === expectedUrl;
}

/**
 * The buyer must pay EXACTLY one of the advertised terms: match the
 * payload's accepted requirements against the 402's accepts list on
 * scheme, network, asset, amount, and payTo. Anything else is a 402.
 */
export function findMatchingRequirements(
  payload: PaymentPayload,
  advertised: PaymentRequirements[],
): PaymentRequirements | null {
  const a = payload.accepted;
  if (!a) return null;
  return (
    advertised.find(
      (r) =>
        r.scheme === a.scheme &&
        r.network === a.network &&
        r.asset === a.asset &&
        r.amount === a.amount &&
        r.payTo === a.payTo,
    ) ?? null
  );
}

/** Error carrying the HTTP status the route should answer with. */
export class PaidRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PaidRequestError";
  }
}

export interface FacilitatorLike {
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }>;
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse>;
}

/**
 * Verify the payment with the facilitator, then settle it on-chain.
 * "Upfront" flow: the handler only runs after a successful settlement.
 * Throws PaidRequestError with the status the route should return.
 */
export async function verifyAndSettle(
  facilitator: FacilitatorLike,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<SettleResponse> {
  let verified;
  try {
    verified = await facilitator.verify(payload, requirements);
  } catch (e) {
    throw new PaidRequestError(
      502,
      `Payment verification failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!verified?.isValid) {
    throw new PaidRequestError(
      402,
      `Payment invalid: ${verified?.invalidReason || "facilitator rejected the payment"}`,
    );
  }
  let settled;
  try {
    settled = await facilitator.settle(payload, requirements);
  } catch (e) {
    throw new PaidRequestError(
      502,
      `Payment settlement failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!settled?.success) {
    throw new PaidRequestError(
      502,
      `Payment did not settle: ${settled?.errorReason || settled?.errorMessage || "unknown settlement error"}`,
    );
  }
  return settled;
}

/** Build the facilitator client for the config (API key only when set). */
export function buildFacilitator(config: PaidEndpointConfig): HTTPFacilitatorClient {
  const apiKey = config.facilitatorApiKey;
  return new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
    createAuthHeaders: async () => {
      if (!apiKey) return {};
      const h = { "X-Api-Key": apiKey };
      return { verify: h, settle: h, supported: h };
    },
  });
}
