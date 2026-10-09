/**
 * Voicescape MCP server — x402 buyer tools (agent as payer).
 *
 * The directory lists agents' self-reported x402 endpoints, but nothing
 * lets an agent BUY from one — sellers with no buyers. These two tools
 * close that gap with the same prepare/complete split the server uses
 * everywhere else:
 *
 *   1. pay_x402_service(action="prepare") — probe the endpoint's 402
 *      terms, pick a rail, and return the UNSIGNED frozen
 *      TransferTransaction bytes for the agent's own key to sign.
 *   2. pay_x402_service(action="complete") — the agent passes back its
 *      signed bytes; the server finishes the 402 handshake with the
 *      PRODUCTION payX402 code path and returns the service response
 *      plus the settle receipt.
 *
 * NON-CUSTODIAL INVARIANT: the server never signs, never holds keys.
 * The agent's signature is applied by the agent; the server only relays
 * the agent-signed bytes through the standard x402 payment flow —
 * exactly like the facilitator pattern. Spend is double-guarded: the
 * complete step re-probes the endpoint and aborts unless the live terms
 * still match what was prepared (network, asset, amount, payTo,
 * feePayer), and payX402's spend controls cap the payment at the rail
 * amount.
 *
 * $0 PLATFORM COST: the buyer (agent) pays the service amount plus
 * Hedera network fees. The platform takes nothing here — the 2%
 * platform economics live on the Tips-contract rails, not x402.
 */

import {
  AccountId,
  Client,
  Hbar,
  Long,
  TokenId,
  Transaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import type { ClientHederaSigner } from "@x402/hedera";
import { isHbarAsset } from "@x402/hedera";
import { probeX402, payX402, type X402Rail } from "../x402";
import { HASHSCAN_TX_BASE } from "../tx-proof";

type FetchFn = typeof fetch;

const ACCOUNT_RE = /^0\.0\.\d+$/;
/** Cap on the service response we relay back (2 MB). */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Paid-call budget: the 402 handshake + service response. */
const PAID_CALL_TIMEOUT_MS = 60_000;

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Build the frozen (UNSIGNED) exact-scheme TransferTransaction for a rail.
 * Mirrors createWalletHederaSigner's transaction construction in
 * lib/x402.ts, stopping before signing: buyer -> payTo for the rail
 * amount, transaction payer = the facilitator's feePayer account (which
 * co-signs and submits). Freezing needs no key.
 */
function buildUnsignedX402Transfer(rail: X402Rail, buyerAccountId: string): string {
  const feePayer = rail.feePayer;
  if (typeof feePayer !== "string" || !ACCOUNT_RE.test(feePayer)) {
    throw new Error("the selected rail has no valid feePayer — cannot build the payment");
  }
  const amount = BigInt(rail.amount);
  if (amount <= 0n) throw new Error("the selected rail amount must be positive");
  const payer = AccountId.fromString(buyerAccountId);
  const payTo = AccountId.fromString(rail.payTo);

  const tx = new TransferTransaction();
  if (isHbarAsset(rail.asset)) {
    tx.addHbarTransfer(payer, Hbar.fromTinybars((-amount).toString()));
    tx.addHbarTransfer(payTo, Hbar.fromTinybars(amount.toString()));
  } else {
    const tokenId = TokenId.fromString(rail.asset);
    tx.addTokenTransfer(tokenId, payer, Long.fromString((-amount).toString()));
    tx.addTokenTransfer(tokenId, payTo, Long.fromString(amount.toString()));
  }
  // Mirror @x402/hedera: the transaction id is generated with the
  // facilitator's fee-payer account as the payer.
  tx.setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));

  const client = Client.forMainnet(); // mainnet only — no testnet
  try {
    tx.freezeWith(client);
    return Buffer.from(tx.toBytes()).toString("base64");
  } finally {
    client.close();
  }
}

export interface X402PrepareArgs {
  endpoint_url: string;
  buyer_account_id: string;
  /** Rail selector: "HBAR", "USDC", or a token id. Default: first HBAR rail, else first rail. */
  asset?: string;
  /** HTTP method for the paid call. Default "POST". */
  request_method?: string;
  /** JSON body string sent with the paid call (e.g. the service input). */
  request_body?: string;
}

export interface X402PreparedRail {
  network: string;
  asset: string;
  kind: string;
  label: string;
  amount: string;
  amount_display: string;
  pay_to: string;
  fee_payer: string;
}

export interface X402Prepared {
  endpoint_url: string;
  description?: string;
  rail: X402PreparedRail;
  buyer_account_id: string;
  buyer_account_exists: boolean;
  /** Base64 frozen TransferTransaction — UNSIGNED. The agent signs this. */
  unsigned_tx_base64: string;
  request: { method: string; body: string };
  instructions: string;
}

/**
 * Step 1: probe the endpoint and prepare the payment for the agent's key.
 */
export async function prepareX402PaymentTool(
  args: X402PrepareArgs,
): Promise<X402Prepared | { error: string }> {
  const endpointUrl = (args.endpoint_url ?? "").toString().trim();
  if (!isHttpUrl(endpointUrl)) {
    return { error: `endpoint_url "${args.endpoint_url}" is not an http(s) URL` };
  }
  const buyerAccountId = (args.buyer_account_id ?? "").toString().trim();
  if (!ACCOUNT_RE.test(buyerAccountId)) {
    return { error: `buyer_account_id "${args.buyer_account_id}" is not a 0.0.x account id` };
  }

  let probe;
  try {
    probe = await probeX402(endpointUrl);
  } catch (e) {
    return { error: `could not read the endpoint's payment terms: ${(e as Error).message}` };
  }
  if (probe.rails.length === 0) {
    return { error: "the endpoint advertised no payment rails" };
  }

  // Rail selection: explicit asset match, else first HBAR rail, else first rail.
  const want = (args.asset ?? "").toString().trim().toLowerCase();
  let rail: X402Rail | undefined;
  if (want) {
    rail = probe.rails.find(
      (r) => r.asset.toLowerCase() === want || r.kind.toLowerCase() === want,
    );
    if (!rail) {
      return {
        error:
          `no rail matches asset "${args.asset}" — available: ` +
          probe.rails.map((r) => `${r.label} (${r.amountDisplay})`).join(", "),
      };
    }
  } else {
    rail = probe.rails.find((r) => r.kind === "HBAR") ?? probe.rails[0];
  }

  let unsignedTxBase64: string;
  try {
    unsignedTxBase64 = buildUnsignedX402Transfer(rail, buyerAccountId);
  } catch (e) {
    return { error: `could not build the payment transaction: ${(e as Error).message}` };
  }

  // Best-effort buyer existence check. NOT a hard error: hollow accounts
  // don't exist until funded, and "earn-first" means the buyer's first
  // paid gig can be what creates its account.
  let buyerExists = false;
  try {
    const res = await fetch(`https://mainnet.mirrornode.hedera.com/api/v1/accounts/${buyerAccountId}`);
    buyerExists = res.ok;
  } catch {
    buyerExists = false;
  }

  const method = (args.request_method ?? "POST").toString().toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return { error: `request_method "${args.request_method}" is not supported` };
  }

  return {
    endpoint_url: endpointUrl,
    description: probe.description,
    rail: {
      network: rail.network,
      asset: rail.asset,
      kind: rail.kind,
      label: rail.label,
      amount: rail.amount,
      amount_display: rail.amountDisplay,
      pay_to: rail.payTo,
      fee_payer: rail.feePayer ?? "",
    },
    buyer_account_id: buyerAccountId,
    buyer_account_exists: buyerExists,
    unsigned_tx_base64: unsignedTxBase64,
    request: { method, body: (args.request_body ?? "{}").toString() },
    instructions:
      "This transaction is UNSIGNED — the server never signed it and never will. " +
      "Decode unsigned_tx_base64, load it as a frozen TransferTransaction with YOUR OWN Hedera key " +
      "(Transaction.fromBytes, then sign with your key — do NOT change amounts, recipients, or the " +
      "transaction id), and re-encode the SIGNED bytes as base64. Then call pay_x402_service with " +
      `action "complete", passing signed_tx_base64 plus the rail terms above (network, asset, amount, ` +
      "pay_to, fee_payer) — the server re-checks the endpoint's live terms and aborts if they changed, " +
      "then finishes the 402 handshake and returns the service response with the settle receipt. " +
      `You pay ${rail.amountDisplay} to ${rail.payTo} plus a small Hedera network fee. ` +
      (buyerExists
        ? ""
        : "Note: your buyer account was not found on mainnet — if it is a hollow account it will be created when the payment lands. ") +
      "Never put your private key in a tool argument or chat message.",
  };
}

export interface X402CompleteArgs {
  endpoint_url: string;
  /** Base64 SIGNED TransferTransaction bytes (the agent signed the prepared bytes). */
  signed_tx_base64: string;
  buyer_account_id: string;
  /** Rail terms from the prepare step — must still match the live terms. */
  expected_network?: string;
  expected_asset?: string;
  expected_amount?: string;
  expected_pay_to?: string;
  expected_fee_payer?: string;
  request_method?: string;
  request_body?: string;
}

export interface X402Completed {
  endpoint_url: string;
  http_status: number;
  content_type: string | null;
  /** Service response body: base64 (always) + text when text/*. Truncated at 2 MB. */
  response_base64: string;
  response_text: string | null;
  response_truncated: boolean;
  settle_tx_id: string | null;
  settle_tx_hashscan: string | null;
  settle_receipt: unknown;
  note: string;
}

/**
 * Step 2: finish the 402 handshake with the agent's signed bytes, using the
 * PRODUCTION payX402 code path. The pre-signed signer just hands back the
 * agent's bytes after verifying the live requirements still match what
 * was prepared — the server relays, never signs.
 */
export async function completeX402PaymentTool(
  args: X402CompleteArgs,
): Promise<X402Completed | { error: string }> {
  const endpointUrl = (args.endpoint_url ?? "").toString().trim();
  if (!isHttpUrl(endpointUrl)) {
    return { error: `endpoint_url "${args.endpoint_url}" is not an http(s) URL` };
  }
  const buyerAccountId = (args.buyer_account_id ?? "").toString().trim();
  if (!ACCOUNT_RE.test(buyerAccountId)) {
    return { error: `buyer_account_id "${args.buyer_account_id}" is not a 0.0.x account id` };
  }
  const signedB64 = (args.signed_tx_base64 ?? "").toString().trim();
  if (!signedB64) return { error: "signed_tx_base64 is required" };

  // Sanity: the bytes must parse as a TransferTransaction. We do NOT
  // verify the signature here — the facilitator does that when it
  // co-signs and submits; an unsigned or tampered tx simply fails there.
  try {
    const tx = Transaction.fromBytes(Buffer.from(signedB64, "base64"));
    if (!(tx instanceof TransferTransaction)) {
      return { error: "signed_tx_base64 does not decode to a TransferTransaction" };
    }
  } catch {
    return { error: "signed_tx_base64 is not decodable transaction bytes" };
  }

  const expected = {
    network: (args.expected_network ?? "").toString(),
    asset: (args.expected_asset ?? "").toString(),
    amount: (args.expected_amount ?? "").toString(),
    payTo: (args.expected_pay_to ?? "").toString(),
    feePayer: (args.expected_fee_payer ?? "").toString(),
  };
  if (!expected.network || !expected.asset || !expected.amount || !expected.payTo) {
    return { error: "expected_network/asset/amount/pay_to from the prepare step are required" };
  }

  // Re-probe: the live terms must still match what was prepared.
  let probe;
  try {
    probe = await probeX402(endpointUrl);
  } catch (e) {
    return { error: `could not re-read the endpoint's payment terms: ${(e as Error).message}` };
  }
  const rail = probe.rails.find(
    (r) => r.network === expected.network && r.asset === expected.asset,
  );
  if (!rail) {
    return { error: "the endpoint no longer offers the prepared rail — aborting, nothing was paid" };
  }
  if (
    rail.amount !== expected.amount ||
    rail.payTo !== expected.payTo ||
    (rail.feePayer ?? "") !== expected.feePayer
  ) {
    return {
      error:
        "the endpoint's live terms changed since prepare (amount/payTo/feePayer differ) — " +
        "aborting, nothing was paid. Re-run prepare to get fresh terms.",
    };
  }

  // Pre-signed signer: hand back the agent's bytes after the live terms
  // check above. The x402 client encodes them into the PAYMENT-SIGNATURE
  // header; the facilitator co-signs as fee payer and submits.
  const preSignedSigner: ClientHederaSigner = {
    accountId: buyerAccountId,
    async createPartiallySignedTransferTransaction() {
      return signedB64;
    },
  };

  const method = (args.request_method ?? "POST").toString().toUpperCase();
  const body = (args.request_body ?? "{}").toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAID_CALL_TIMEOUT_MS);
  try {
    const paid = await payX402(
      endpointUrl,
      {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : body,
        signal: controller.signal,
      },
      rail,
      preSignedSigner,
    );
    const contentType = paid.response.headers.get("content-type");
    const buf = Buffer.from(await paid.response.arrayBuffer());
    const truncated = buf.length > MAX_RESPONSE_BYTES;
    const sliced = truncated ? buf.subarray(0, MAX_RESPONSE_BYTES) : buf;
    const isText = (contentType ?? "").startsWith("text/");
    return {
      endpoint_url: endpointUrl,
      http_status: paid.response.status,
      content_type: contentType,
      response_base64: sliced.toString("base64"),
      response_text: isText ? sliced.toString("utf-8").slice(0, 32768) : null,
      response_truncated: truncated,
      settle_tx_id: paid.settleTxId,
      settle_tx_hashscan: paid.settleTxId ? `${HASHSCAN_TX_BASE}/${paid.settleTxId}` : null,
      settle_receipt: paid.settleReceipt,
      note:
        "Payment completed with YOUR signature — the server only relayed your signed bytes. " +
        "The settle receipt is the on-chain proof of payment; keep settle_tx_id for reviews. " +
        (paid.response.status === 200
          ? ""
          : `The service returned HTTP ${paid.response.status} AFTER payment — the payment still settled; contact the service operator about the response.`),
    };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    return {
      error:
        msg.includes("abort") || (e as Error).name === "AbortError"
          ? "the paid call timed out after 60s — the payment may or may not have settled; check the endpoint or your account before retrying"
          : `the paid call failed: ${msg}`,
    } as { error: string };
  } finally {
    clearTimeout(timer);
  }
}
