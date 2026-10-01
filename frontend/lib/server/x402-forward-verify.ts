/**
 * x402 2%-forward verifier — makes the agent's best-effort treasury forward
 * CHECKABLE instead of trust-me.
 *
 * The x402 flow: a buyer pays the agent IN FULL over x402 (a plain
 * TransferTransaction, buyer -> agent, with the facilitator as fee-payer),
 * and the agent's server is supposed to forward 2% to the Voicescape
 * treasury (0.0.10424063) afterwards — best-effort, not atomic. This module
 * answers, for any payment transaction id: did a ~2% forward to the
 * treasury actually land?
 *
 * How it works (Hedera mainnet mirror-node REST only — no new deps):
 *  1. Fetch the payment tx. It must exist with result SUCCESS.
 *  2. Identify the payment: the largest positive transfer in the tx is the
 *     agent's receipt. Network fees (facilitator fee-payer, node accounts)
 *     are orders of magnitude smaller, so the payment credit is
 *     unambiguous. HBAR payments read `transfers`; token payments read
 *     `token_transfers` (exactly one token with positive transfers, else
 *     the payment is reported ambiguous — never guessed).
 *  3. Check the payment tx itself for an atomic 2% treasury credit (covers
 *     contract-split payments like tipPage/buyListing, where the split is
 *     already on-chain in the same tx).
 *  4. Dust rule (standing economics: never spend more forwarding than the
 *     forward is worth): when 2% of the payment is below the dust
 *     threshold, no forward is required — reported honestly, not as a
 *     missing forward.
 *  5. Otherwise scan the agent wallet's outgoing transfers for 7 days after
 *     the payment (exact-string timestamp cursors — never parseFloat),
 *     looking for a treasury credit of 1.5%–2.5% of the payment in the
 *     same asset.
 *
 * This is a verification aid, not an allegation machine: every
 * not-verified outcome says what was and wasn't found, never that anyone
 * stole anything.
 *
 * Read-only: no signing, no submitting, no state writes. Mainnet only —
 * there is no testnet path by design (Brandon's rule).
 */

import { normalizeTxId, tinybarToHbar, HASHSCAN_TX_BASE } from "../tx-proof";
import { resolveUsernameForOwner } from "../registry-reverse";

const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";
/** Voicescape treasury — every 2% fee split goes here. No exceptions. */
const TREASURY_ID = "0.0.10424063";
/** Native Hedera USDC (6 decimals) — the only non-HBAR asset with a priced dust rule. */
const USDC_TOKEN_ID = "0.0.456858";

const FETCH_TIMEOUT_MS = 10_000;

/** Forward scan window: 7 days after the payment's consensus timestamp. */
const SCAN_WINDOW_S = 7 * 24 * 3_600;
const SCAN_PAGE_LIMIT = 100;
/** Hard page cap — bounds the work (and mirror-node cost) per call. */
const SCAN_MAX_PAGES = 25;

/**
 * Dust threshold, HBAR leg. When 2% of an HBAR payment is below this, no
 * forward is required: forwarding would cost more in network fees than the
 * forward itself. Math: a Hedera crypto transfer costs ~$0.0001 in network
 * fees; at ~$0.20/HBAR that is ~50,000 tinybars; the threshold is 2x the
 * fee = 100,000 tinybars (0.001 HBAR). Conservative on purpose, and
 * documented here rather than hidden.
 */
const DUST_THRESHOLD_TINYBARS = 100_000n;
/**
 * Dust threshold, USDC leg (6 decimals). Same $0.0001-fee math: 100 base
 * units of fee, 2x = 200 base units (0.0002 USDC). Other tokens have no
 * priced dust rule (no oracle) — they always scan.
 */
const DUST_THRESHOLD_USDC_UNITS = 200n;

/* ------------------------------------------------------------------ */
/* Mirror-node shapes (defensive parsing — never trust blindly)        */
/* ------------------------------------------------------------------ */

interface MirrorTransfer {
  account: string;
  amount: bigint;
}

interface MirrorTokenTransfer {
  token_id: string;
  account: string;
  amount: bigint;
}

interface MirrorTx {
  transaction_id: string;
  result: string;
  consensus_timestamp: string;
  transfers: MirrorTransfer[];
  token_transfers: MirrorTokenTransfer[];
}

function toBigInt(v: unknown): bigint | null {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
    return null;
  } catch {
    return null;
  }
}

function parseTransfer(t: unknown): MirrorTransfer | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  const account = typeof o.account === "string" ? o.account : null;
  const amount = toBigInt(o.amount);
  if (!account || amount === null) return null;
  return { account, amount };
}

function parseTokenTransfer(t: unknown): MirrorTokenTransfer | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  const token_id = typeof o.token_id === "string" ? o.token_id : null;
  const account = typeof o.account === "string" ? o.account : null;
  const amount = toBigInt(o.amount);
  if (!token_id || !account || amount === null) return null;
  return { token_id, account, amount };
}

function parseTx(j: unknown): MirrorTx | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const transaction_id = typeof o.transaction_id === "string" ? o.transaction_id : null;
  const result = typeof o.result === "string" ? o.result : null;
  const consensus_timestamp =
    typeof o.consensus_timestamp === "string" ? o.consensus_timestamp : null;
  if (!transaction_id || !result || !consensus_timestamp) return null;
  const transfers = Array.isArray(o.transfers)
    ? o.transfers.map(parseTransfer).filter((t): t is MirrorTransfer => t !== null)
    : [];
  const token_transfers = Array.isArray(o.token_transfers)
    ? o.token_transfers.map(parseTokenTransfer).filter((t): t is MirrorTokenTransfer => t !== null)
    : [];
  return { transaction_id, result, consensus_timestamp, transfers, token_transfers };
}

type FetchFn = typeof fetch;

async function mirrorGetJson(url: string, fetchImpl: FetchFn): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Result type                                                         */
/* ------------------------------------------------------------------ */

export type ForwardVerifyError =
  | "malformed-tx-id"
  | "payment-not-found"
  | "payment-not-successful"
  | "no-payment-transfer"
  | "ambiguous-payment"
  | "mirror-unreachable";

export interface ForwardVerifySuccess {
  ok: true;
  /** True when a ~2% treasury forward was found (or none was required). */
  verified: boolean;
  /** Canonical dash-form payment tx id. */
  paymentTx: string;
  /** The wallet that received the payment. */
  agentWallet: string;
  /** The wallet's registered Voicescape page, if it owns one (best-effort). */
  agentPage: string | null;
  /** Paid amount, in the asset's smallest units (exact integer string). */
  paidAmount: string;
  /** "HBAR" or the HTS token id. */
  paidAsset: string;
  /** Human display, e.g. "10 HBAR" / "5000 base units of 0.0.9999". */
  paidAmountDisplay: string;
  /** Tx id carrying the forward, or the payment tx itself when atomic. Null when none found. */
  forwardTx: string | null;
  /** Forwarded amount in smallest units (exact integer string). Null when none found. */
  forwardedAmount: string | null;
  /** Machine-readable outcome. */
  reason:
    | "forward-found"
    | "forward-in-payment-tx"
    | "no-forward-in-window"
    | "dust-below-threshold";
  /** Human sentence. Never accusatory. */
  detail: string;
  hashscan: string;
  scannedFrom: string;
  scannedTo: string;
  pagesScanned: number;
}

export type ForwardVerifyResult =
  | ForwardVerifySuccess
  | { ok: false; error: ForwardVerifyError; detail: string };

/* ------------------------------------------------------------------ */
/* Payment identification                                              */
/* ------------------------------------------------------------------ */

interface IdentifiedPayment {
  agentWallet: string;
  amount: bigint;
  /** "HBAR" or token id. */
  asset: string;
}

/**
 * Identify the agent's receipt inside a successful payment tx.
 * - Token path first: when exactly one token has positive transfers, the
 *   largest positive token credit is the payment.
 * - Otherwise the HBAR path: the largest positive HBAR transfer is the
 *   payment credit (network-fee credits are orders of magnitude smaller).
 * Returns null with a reason when the payment can't be identified without
 * guessing.
 */
function identifyPayment(tx: MirrorTx): { ok: true; payment: IdentifiedPayment } | { ok: false; error: "no-payment-transfer" | "ambiguous-payment" } {
  const positiveTokens = tx.token_transfers.filter((t) => t.amount > 0n);
  const tokenIds = [...new Set(positiveTokens.map((t) => t.token_id))];
  if (tokenIds.length > 1) return { ok: false, error: "ambiguous-payment" };
  if (tokenIds.length === 1) {
    const id = tokenIds[0];
    const best = positiveTokens
      .filter((t) => t.token_id === id)
      .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))[0];
    return { ok: true, payment: { agentWallet: best.account, amount: best.amount, asset: id } };
  }
  const positiveHbar = tx.transfers.filter((t) => t.amount > 0n);
  if (positiveHbar.length === 0) return { ok: false, error: "no-payment-transfer" };
  const best = positiveHbar.sort((a, b) =>
    b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0,
  )[0];
  return { ok: true, payment: { agentWallet: best.account, amount: best.amount, asset: "HBAR" } };
}

/** True when `forward` is within 1.5%–2.5% of `paid` (integer math, exact). */
function inForwardTolerance(forward: bigint, paid: bigint): boolean {
  if (paid <= 0n || forward <= 0n) return false;
  return forward * 200n >= paid * 3n && forward * 200n <= paid * 5n;
}

/**
 * Dust rule: when 2% of the payment is below the threshold where the
 * forward would cost more in network fees than it sends, no forward is
 * required. Only HBAR and USDC are priced (no oracle for other tokens —
 * they always scan).
 */
function dustThresholdFor(asset: string): bigint | null {
  if (asset === "HBAR") return DUST_THRESHOLD_TINYBARS;
  if (asset === USDC_TOKEN_ID) return DUST_THRESHOLD_USDC_UNITS;
  return null;
}

function formatPaidAmount(amount: bigint, asset: string): string {
  if (asset === "HBAR") return `${tinybarToHbar(amount)} HBAR`;
  return `${amount.toString()} base units of ${asset}`;
}

/** Add whole seconds to a "seconds.nanos" timestamp (integer math on the seconds part). */
function addSeconds(ts: string, seconds: number): string {
  const dot = ts.indexOf(".");
  const secs = dot === -1 ? ts : ts.slice(0, dot);
  const nanos = dot === -1 ? "0" : ts.slice(dot + 1);
  return `${(BigInt(secs) + BigInt(seconds)).toString()}.${nanos}`;
}

/** Canonical dash form for comparing mirror-node transaction ids. */
function dashForm(txId: string): string {
  const m = /^0\.0\.(\d+)@(\d+)\.(\d+)$/.exec(txId.trim());
  if (m) return `0.0.${m[1]}-${m[2]}-${m[3]}`;
  return txId; // already dash form or an evm hash — compare as-is
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

export interface VerifyDeps {
  fetchImpl?: FetchFn;
  /** Injected for tests; defaults to the on-chain registry lookup. */
  resolvePage?: (wallet: string) => Promise<string | null>;
}

/**
 * Verify the 2% treasury forward for one x402 payment transaction.
 * Read-only. Never throws for expected failure modes — they come back as
 * `{ ok: false, error }` with a human `detail`.
 */
export async function verifyX402Forward(
  rawPaymentTx: string,
  deps: VerifyDeps = {},
): Promise<ForwardVerifyResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolvePage = deps.resolvePage ?? resolveUsernameForOwner;

  const norm = normalizeTxId(rawPaymentTx);
  if (!norm.ok) {
    return {
      ok: false,
      error: "malformed-tx-id",
      detail:
        "That doesn't look like a Hedera transaction id (expected 0.0.x@seconds.nanos or 0.0.x-seconds-nanos).",
    };
  }

  // 1. Fetch the payment tx.
  const txJson = await mirrorGetJson(`${MIRROR_BASE}/transactions/${norm.txId}`, fetchImpl);
  const txList = (txJson as { transactions?: unknown } | null)?.transactions;
  const tx = Array.isArray(txList) ? txList.map(parseTx).find((t) => t !== null) ?? null : null;
  if (!tx) {
    // Distinguish "mirror down" from "tx unknown": a null body on a
    // reachable mirror means not-found; mirrorGetJson already returns null
    // for both, so probe cheaply is overkill — report not-found with the
    // honest caveat.
    return {
      ok: false,
      error: "payment-not-found",
      detail:
        "The mirror node has no record of that transaction (it may be too new — records can lag consensus by a few seconds — or the id may be wrong).",
    };
  }
  if (tx.result !== "SUCCESS") {
    return {
      ok: false,
      error: "payment-not-successful",
      detail: `That transaction exists but did not succeed on-chain (result: ${tx.result}) — it can't be a completed payment.`,
    };
  }

  // 2. Identify the payment.
  const identified = identifyPayment(tx);
  if (!identified.ok) {
    return {
      ok: false,
      error: identified.error,
      detail:
        identified.error === "ambiguous-payment"
          ? "That transaction moves several different tokens, so the payment can't be identified without guessing. Pass the receipt transaction from the x402 PAYMENT-RESPONSE header instead."
          : "That transaction contains no payment-like transfer to anyone — nothing was paid, so there is no forward to verify.",
    };
  }
  const { agentWallet, amount: paidAmount, asset: paidAsset } = identified.payment;
  const paidDisplay = formatPaidAmount(paidAmount, paidAsset);
  const hashscan = `${HASHSCAN_TX_BASE}/${norm.txId}`;

  // 3. Atomic case: the payment tx itself already carries the 2% split
  //    (tipPage / buyListing). Then the forward IS the payment tx.
  const inTxForward = paidAsset === "HBAR"
    ? tx.transfers.find(
        (t) => t.account === TREASURY_ID && inForwardTolerance(t.amount, paidAmount),
      )
    : (tx.token_transfers ?? []).find(
        (t) =>
          t.token_id === paidAsset &&
          t.account === TREASURY_ID &&
          inForwardTolerance(t.amount, paidAmount),
      );
  const agentPage = await resolvePage(agentWallet).catch(() => null);
  if (inTxForward) {
    const fwdDisplay = formatPaidAmount(inTxForward.amount, paidAsset);
    return {
      ok: true,
      verified: true,
      paymentTx: norm.txId,
      agentWallet,
      agentPage,
      paidAmount: paidAmount.toString(),
      paidAsset,
      paidAmountDisplay: paidDisplay,
      forwardTx: norm.txId,
      forwardedAmount: inTxForward.amount.toString(),
      reason: "forward-in-payment-tx",
      detail: `The 2% treasury split (${fwdDisplay}) is already inside the payment transaction itself — split atomically on-chain. Nothing further to forward.`,
      hashscan,
      scannedFrom: tx.consensus_timestamp,
      scannedTo: tx.consensus_timestamp,
      pagesScanned: 0,
    };
  }

  // 4. Dust rule — a forward that costs more than it sends is not required.
  const dustThreshold = dustThresholdFor(paidAsset);
  if (dustThreshold !== null && paidAmount * 2n < dustThreshold * 100n) {
    // paidAmount * 2 / 100 < threshold  <=>  paidAmount * 2 < threshold * 100
    const twoPct = formatPaidAmount((paidAmount * 2n) / 100n, paidAsset);
    const thresholdDisplay = formatPaidAmount(dustThreshold, paidAsset);
    return {
      ok: true,
      verified: false,
      paymentTx: norm.txId,
      agentWallet,
      agentPage,
      paidAmount: paidAmount.toString(),
      paidAsset,
      paidAmountDisplay: paidDisplay,
      forwardTx: null,
      forwardedAmount: null,
      reason: "dust-below-threshold",
      detail: `2% of this payment (${twoPct}) is below the dust threshold (${thresholdDisplay}) where forwarding would cost more in network fees than the forward itself. No forward is required below this threshold — this is the standing economics rule, not a missing payment.`,
      hashscan,
      scannedFrom: tx.consensus_timestamp,
      scannedTo: tx.consensus_timestamp,
      pagesScanned: 0,
    };
  }

  // 5. Scan the agent wallet's transfers for 7 days after the payment.
  const scannedFrom = tx.consensus_timestamp;
  const scannedTo = addSeconds(scannedFrom, SCAN_WINDOW_S);
  const paymentDash = dashForm(tx.transaction_id);
  let cursor = `gte:${scannedFrom}`;
  let pagesScanned = 0;

  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const url =
      `${MIRROR_BASE}/transactions?account.id=${agentWallet}` +
      `&timestamp=${encodeURIComponent(cursor)}` +
      `&timestamp=lt:${encodeURIComponent(scannedTo)}` +
      `&type=CRYPTOTRANSFER&order=asc&limit=${SCAN_PAGE_LIMIT}`;
    const pageJson = await mirrorGetJson(url, fetchImpl);
    const list = (pageJson as { transactions?: unknown } | null)?.transactions;
    if (!Array.isArray(list)) {
      return {
        ok: false,
        error: "mirror-unreachable",
        detail:
          "The mirror node didn't answer mid-scan. Nothing was concluded — retry in a moment.",
      };
    }
    const txs = list.map(parseTx).filter((t): t is MirrorTx => t !== null);
    pagesScanned++;

    for (const cand of txs) {
      if (dashForm(cand.transaction_id) === paymentDash) continue; // never match the payment tx itself
      const match =
        paidAsset === "HBAR"
          ? cand.transfers.find(
              (t) => t.account === TREASURY_ID && inForwardTolerance(t.amount, paidAmount),
            )
          : (cand.token_transfers ?? []).find(
              (t) =>
                t.token_id === paidAsset &&
                t.account === TREASURY_ID &&
                inForwardTolerance(t.amount, paidAmount),
            );
      if (match) {
        const fwdDisplay = formatPaidAmount(match.amount, paidAsset);
        return {
          ok: true,
          verified: true,
          paymentTx: norm.txId,
          agentWallet,
          agentPage,
          paidAmount: paidAmount.toString(),
          paidAsset,
          paidAmountDisplay: paidDisplay,
          forwardTx: dashForm(cand.transaction_id),
          forwardedAmount: match.amount.toString(),
          reason: "forward-found",
          detail: `Found it: ${fwdDisplay} reached the treasury in ${dashForm(cand.transaction_id)} — about 2% of the ${paidDisplay} payment.`,
          hashscan,
          scannedFrom,
          scannedTo,
          pagesScanned,
        };
      }
    }

    if (txs.length < SCAN_PAGE_LIMIT) break; // last page
    // Exact-string cursor from the last tx — never parseFloat (it rounds
    // nanos and re-fetches the same trailing tx forever).
    const lastTs = txs[txs.length - 1].consensus_timestamp;
    cursor = `gt:${lastTs}`;
  }

  return {
    ok: true,
    verified: false,
    paymentTx: norm.txId,
    agentWallet,
    agentPage,
    paidAmount: paidAmount.toString(),
    paidAsset,
    paidAmountDisplay: paidDisplay,
    forwardTx: null,
    forwardedAmount: null,
    reason: "no-forward-in-window",
    detail:
      `No transfer to the treasury matching ~2% of the ${paidDisplay} payment was found ` +
      `in the 7 days after it (${pagesScanned} page${pagesScanned === 1 ? "" : "s"} scanned). ` +
      `This is not an accusation — the forward may have been sent from a different wallet, ` +
      `batched with other payments, or sent on a different schedule. Ask the agent for their forward transaction id.`,
    hashscan,
    scannedFrom,
    scannedTo,
    pagesScanned,
  };
}
