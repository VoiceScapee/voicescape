"use client";

/**
 * Client-side x402 (v2) payment handshake for Voicescape.
 *
 * Used by two flows:
 *  1. Agent storefront "Pay per call" buttons — probe the service's 402,
 *     let the buyer pick a rail (HBAR / USDC / other), pay via the wallet,
 *     and return the service's response.
 *  2. Builder AI-edit "pay per request" — the page owner pays the x402
 *     vibecode endpoint per AI edit (the loop closes: agents pay for their
 *     own edits through this flow).
 *
 * Signing is wallet-backed (HashConnect), never raw keys: we implement the
 * @x402/hedera ClientHederaSigner interface over the paired wallet. The
 * mechanics mirror @x402/hedera's createClientHederaSigner (partially-signed
 * TransferTransaction, buyer signature only, facilitator feePayer as payer)
 * — verified against @x402/hedera@2.25.0 sources (read-only).
 */

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import type {
  PaymentRequirements,
  SelectPaymentRequirements,
} from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { ClientHederaSigner } from "@x402/hedera";
import {
  HEDERA_MAINNET_CAIP2,
  HEDERA_TESTNET_CAIP2,
  HEDERA_MAINNET_USDC,
  HEDERA_TESTNET_USDC,
  HEDERA_USDC_DECIMALS,
  isHbarAsset,
} from "@x402/hedera";
import {
  AccountId,
  Client,
  Hbar,
  TokenId,
  Transaction,
  TransactionId,
  TransferTransaction,
} from "@hashgraph/sdk";

/* ------------------------------------------------------------------ */
/* Small helpers (browser-safe, no Buffer)                             */
/* ------------------------------------------------------------------ */

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function base64ToJson<T>(b64: string): T {
  // 402 headers are ASCII JSON; atob is sufficient.
  return JSON.parse(atob(b64)) as T;
}

/* ------------------------------------------------------------------ */
/* Rails                                                               */
/* ------------------------------------------------------------------ */

/** Canonical USDC token id per Hedera network (from @x402/hedera). */
export const USDC_ASSET_BY_NETWORK: Record<string, string> = {
  [HEDERA_TESTNET_CAIP2]: HEDERA_TESTNET_USDC,
  [HEDERA_MAINNET_CAIP2]: HEDERA_MAINNET_USDC,
};

export type RailKind = "HBAR" | "USDC" | "TOKEN";

export interface X402Rail {
  /** CAIP-2 network id, e.g. "hedera:testnet". */
  network: `${string}:${string}`;
  asset: string;
  kind: RailKind;
  /** Display label: HBAR, USDC, or the raw token id. */
  label: string;
  /** Amount in the asset's smallest units, exactly as the 402 advertises. */
  amount: string;
  /** Human display, e.g. "0.05 HBAR" / "1.00 USDC". */
  amountDisplay: string;
  /** Estimated USD cents (HBAR via price feed, USDC 1:1). null when unknown. */
  usdCents: number | null;
  payTo: string;
  feePayer?: string;
}

export function railDecimals(kind: RailKind): number {
  switch (kind) {
    case "HBAR":
      return 8;
    case "USDC":
      return HEDERA_USDC_DECIMALS;
    default:
      return 0;
  }
}

export function classifyRail(network: string, asset: string): { kind: RailKind; label: string } {
  if (isHbarAsset(asset)) return { kind: "HBAR", label: "HBAR" };
  const usdc = USDC_ASSET_BY_NETWORK[network];
  if (usdc && asset.toLowerCase() === usdc.toLowerCase()) {
    return { kind: "USDC", label: "USDC" };
  }
  return { kind: "TOKEN", label: asset };
}

export function formatRailAmount(asset: string, network: string, amount: string): string {
  const { kind, label } = classifyRail(network, asset);
  const decimals = railDecimals(kind);
  try {
    const whole = BigInt(amount);
    const div = 10n ** BigInt(decimals);
    const int = whole / div;
    const frac = (whole % div).toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${int.toString()}${frac ? "." + frac : ""} ${label}`;
  } catch {
    return `${amount} ${label}`;
  }
}

/* ------------------------------------------------------------------ */
/* HBAR/USD price (approximate, display only)                           */
/* ------------------------------------------------------------------ */

let hbarPriceCache: { price: number; at: number } | null = null;

/**
 * Approximate HBAR price in USD, for DISPLAY conversion only — never for
 * settlement (the 402's advertised amount is authoritative). Env override
 * NEXT_PUBLIC_HBAR_USD_PRICE wins; otherwise CoinGecko, otherwise 0.20.
 */
export async function getHbarUsdPrice(): Promise<number> {
  const env = Number(process.env.NEXT_PUBLIC_HBAR_USD_PRICE);
  if (Number.isFinite(env) && env > 0) return env;
  const now = Date.now();
  if (hbarPriceCache && now - hbarPriceCache.at < 5 * 60_000) return hbarPriceCache.price;
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=hedera-hashgraph&vs_currencies=usd",
    );
    const json = (await res.json()) as { "hedera-hashgraph"?: { usd?: unknown } };
    const p = Number(json?.["hedera-hashgraph"]?.usd);
    if (Number.isFinite(p) && p > 0) {
      hbarPriceCache = { price: p, at: now };
      return p;
    }
  } catch {
    // fall through to the labeled fallback
  }
  return 0.2;
}

/** Estimate USD cents for a rail amount. Returns null for unknown tokens. */
export async function railUsdCents(rail: Pick<X402Rail, "kind" | "amount">): Promise<number | null> {
  try {
    if (rail.kind === "USDC") {
      return Math.round((Number(BigInt(rail.amount)) / 10 ** HEDERA_USDC_DECIMALS) * 100);
    }
    if (rail.kind === "HBAR") {
      const price = await getHbarUsdPrice();
      return Math.round((Number(BigInt(rail.amount)) / 1e8) * price * 100);
    }
  } catch {
    // fall through
  }
  return null;
}

export function formatUsdCents(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return "price in USD unknown";
  return `≈ $${(cents / 100).toFixed(2)} USD`;
}

/* ------------------------------------------------------------------ */
/* 402 probe — read the advertised rails without paying                 */
/* ------------------------------------------------------------------ */

interface PaymentRequiredDoc {
  x402Version: number;
  resource?: { url?: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
}

export interface X402Probe {
  rails: X402Rail[];
  description?: string;
  resourceUrl?: string;
}

/**
 * Hit an x402 endpoint WITHOUT payment to read its 402 terms.
 * The x402 middleware 402s before the handler runs, so any body works —
 * we send an empty JSON object.
 */
export async function probeX402(url: string): Promise<X402Probe> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (res.status !== 402) {
    const text = await res.text().catch(() => "");
    throw new Error(
      res.status === 200
        ? "This endpoint did not ask for payment (no 402) — it may be free."
        : `Expected a 402 Payment Required response, got ${res.status}. ${text.slice(0, 200)}`,
    );
  }
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new Error("402 response is missing the PAYMENT-REQUIRED header.");
  let doc: PaymentRequiredDoc;
  try {
    doc = base64ToJson<PaymentRequiredDoc>(header);
  } catch {
    throw new Error("Could not decode the PAYMENT-REQUIRED header.");
  }
  if (!Array.isArray(doc.accepts) || doc.accepts.length === 0) {
    throw new Error("The 402 response advertises no payment options.");
  }
  const rails: X402Rail[] = await Promise.all(
    doc.accepts.map(async (req) => {
      const { kind, label } = classifyRail(req.network, req.asset);
      const rail: X402Rail = {
        network: req.network,
        asset: req.asset,
        kind,
        label,
        amount: req.amount,
        amountDisplay: formatRailAmount(req.asset, req.network, req.amount),
        usdCents: null,
        payTo: req.payTo,
        feePayer: typeof req.extra?.feePayer === "string" ? req.extra.feePayer : undefined,
      };
      rail.usdCents = await railUsdCents(rail);
      return rail;
    }),
  );
  return { rails, description: doc.resource?.description, resourceUrl: doc.resource?.url };
}

/* ------------------------------------------------------------------ */
/* Wallet-backed Hedera signer for the x402 "exact" scheme              */
/* ------------------------------------------------------------------ */

/** Sign a frozen TransferTransaction in the wallet; returns the signed tx. */
export type WalletSignTx = (tx: TransferTransaction) => Promise<Transaction>;

/**
 * Build a @x402/hedera ClientHederaSigner over the paired wallet.
 * The buyer signs a partially-signed TransferTransaction (buyer signature
 * only); the facilitator adds the fee-payer signature and submits.
 */
export function createWalletHederaSigner(accountId: string, signTx: WalletSignTx): ClientHederaSigner {
  return {
    accountId,
    async createPartiallySignedTransferTransaction(
      requirements: PaymentRequirements,
    ): Promise<string> {
      const feePayer = requirements.extra?.feePayer;
      if (typeof feePayer !== "string") {
        throw new Error("x402: feePayer is required in paymentRequirements.extra for Hedera exact payments.");
      }
      const amount = BigInt(requirements.amount);
      if (amount <= 0n) throw new Error("x402: amount must be greater than zero.");
      const payer = AccountId.fromString(accountId);
      const payTo = AccountId.fromString(requirements.payTo);

      const tx = new TransferTransaction();
      if (isHbarAsset(requirements.asset)) {
        tx.addHbarTransfer(payer, Hbar.fromTinybars((-amount).toString()));
        tx.addHbarTransfer(payTo, Hbar.fromTinybars(amount.toString()));
      } else {
        const tokenId = TokenId.fromString(requirements.asset);
        tx.addTokenTransfer(tokenId, payer, -amount);
        tx.addTokenTransfer(tokenId, payTo, amount);
      }
      // Mirror @x402/hedera: transaction id is generated with the
      // facilitator's fee-payer account as the payer.
      tx.setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));

      const client =
        requirements.network === HEDERA_MAINNET_CAIP2 ? Client.forMainnet() : Client.forTestnet();
      try {
        tx.freezeWith(client);
        const signed = await signTx(tx);
        return bytesToBase64(signed.toBytes());
      } finally {
        client.close();
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Pay + call                                                          */
/* ------------------------------------------------------------------ */

export interface PaidCallResult {
  response: Response;
  /** Settle receipt transaction id from the PAYMENT-RESPONSE header, if any. */
  settleTxId: string | null;
  /** Raw decoded settle receipt, if the header was present. */
  settleReceipt: { success?: boolean; transaction?: string; payer?: string; errorReason?: string } | null;
}

/**
 * Pay for ONE call on the buyer's chosen rail and return the response.
 * The selector pins the payment to `rail` — the buyer already chose it in
 * the UI — and spend controls whitelist only that asset as a second guard.
 */
export async function payX402(
  url: string,
  init: RequestInit,
  rail: X402Rail,
  signer: ClientHederaSigner,
): Promise<PaidCallResult> {
  const selector: SelectPaymentRequirements = (_x402Version, reqs) => {
    const hit = reqs.find((r) => r.network === rail.network && r.asset === rail.asset);
    if (!hit) {
      throw new Error(`The service no longer offers the ${rail.label} rail — probe again.`);
    }
    return hit;
  };
  const client = new x402Client(selector)
    .register(rail.network, new ExactHederaScheme(signer))
    .setSpendControls({
      allowedAssets: [{ network: rail.network, asset: rail.asset, maxAmountPerPayment: rail.amount }],
    });
  const fetchWithPay = wrapFetchWithPayment(fetch, client);
  const response = await fetchWithPay(url, init);

  const settleHeader = response.headers.get("PAYMENT-RESPONSE");
  let settleReceipt: PaidCallResult["settleReceipt"] = null;
  if (settleHeader) {
    try {
      settleReceipt = base64ToJson<PaidCallResult["settleReceipt"]>(settleHeader);
    } catch {
      settleReceipt = null;
    }
  }
  return {
    response,
    settleTxId: settleReceipt?.transaction ?? null,
    settleReceipt,
  };
}

/* ------------------------------------------------------------------ */
/* Vibecode endpoint                                                   */
/* ------------------------------------------------------------------ */

/** Full URL of the x402 vibecode endpoint, e.g. http://localhost:3000/vibecode */
export function getX402VibecodeUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_X402_VIBECODE_URL;
  return url && url.length > 0 ? url : null;
}
