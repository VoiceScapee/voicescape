/**
 * Obligation lifecycle records — the merchant-attested half of a payment receipt.
 *
 * A chain receipt proves SETTLEMENT (money moved, consensus SUCCESS). It cannot
 * say what the payment was FOR — fulfilment, repayment, refund, or a transfer
 * between related parties is known only to the merchant side. This module
 * records that second half: a versioned, wallet-attested lifecycle per payment
 * transaction, so ground-floor payment activity becomes a usable credit file
 * instead of just a payment history.
 *
 * Lifecycle: settled (payment confirmed on the mirror node) -> fulfilled |
 * disputed; disputed -> fulfilled | refunded. fulfilled/refunded are terminal.
 *
 * Who may attest what (session wallet must match):
 *   - fulfilled / refunded: the payee (merchant received payment / sent refund)
 *   - disputed: the payer (claims non-delivery / problem)
 *
 * The payment itself is verified against the Hedera mainnet mirror node
 * (proven path — same as tx-proof.ts and x402-forward-verify.ts): the
 * transaction must exist with result SUCCESS. Payer = largest debit,
 * payee = largest credit (HBAR, or exactly one token — ambiguous multi-token
 * payments are refused, never guessed).
 *
 * Honest limits (v1): no obligation-before-payment issuance (the payment tx
 * is the anchor — "due"/"repaid" for lender-issued obligations is future
 * work); no cross-payment netting; attestations are self-reported by the
 * counterparty wallets, exactly like the rest of the directory.
 *
 * Storage: shared KV (lib/server/store.ts), 2-year TTL — these are credit
 * records, meant to last. No chain writes, no fees, no PII beyond the
 * wallet addresses already on the public ledger.
 */

import { getKvStore, type KvStore } from "./store";
import { normalizeTxId, HASHSCAN_TX_BASE } from "../tx-proof";

const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";
const OBLIGATION_KEY_PREFIX = "obligation:";
const OBLIGATION_RL_PREFIX = "obligation:rl:";
const OBLIGATION_TTL_MS = 2 * 365 * 24 * 3_600_000;
const RL_TTL_MS = 24 * 3_600_000;
const RL_MAX_PER_DAY = 20;
const MAX_NOTE_LEN = 280;

export type ObligationState = "settled" | "fulfilled" | "disputed" | "refunded";
export type AttestState = "fulfilled" | "disputed" | "refunded";

export interface ObligationAttestation {
  state: AttestState;
  attested_by: string;
  attested_at: string;
  note: string | null;
}

export interface ObligationRecord {
  payment_tx_id: string;
  payer: string;
  payee: string;
  amount: string;
  /** "HBAR" or token id. */
  asset: string;
  consensus_timestamp: string;
  hashscan: string;
  state: ObligationState;
  attestations: ObligationAttestation[];
  created_at: string;
  updated_at: string;
}

export type AttestError =
  | "bad-tx-id"
  | "payment-not-found"
  | "payment-not-successful"
  | "ambiguous-payment"
  | "not-a-counterparty"
  | "bad-state"
  | "terminal-state"
  | "rate-limited"
  | "unavailable";

export type AttestResult =
  | { ok: true; record: ObligationRecord }
  | { ok: false; error: AttestError; detail: string };

interface MirrorTransfer {
  account: string;
  amount: string | number;
}

interface MirrorTx {
  transaction_id: string;
  result: string;
  consensus_timestamp: string;
  transfers: MirrorTransfer[];
  token_transfers: Array<{ token_id: string; account: string; amount: string | number }>;
}

type FetchFn = typeof fetch;

function toBigInt(v: string | number): bigint | null {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
    return null;
  } catch {
    return null;
  }
}

/** Next legal states from each state. Empty = terminal. */
const TRANSITIONS: Record<ObligationState, AttestState[]> = {
  settled: ["fulfilled", "disputed"],
  disputed: ["fulfilled", "refunded"],
  fulfilled: [],
  refunded: [],
};

/** Which side of the payment may attest each state. */
const ATTEST_SIDE: Record<AttestState, "payer" | "payee"> = {
  fulfilled: "payee",
  refunded: "payee",
  disputed: "payer",
};

interface SettledPayment {
  payer: string;
  payee: string;
  amount: bigint;
  asset: string;
  consensusTimestamp: string;
}

async function fetchSettledPayment(
  dashTxId: string,
  fetchImpl: FetchFn,
): Promise<{ ok: true; payment: SettledPayment } | { ok: false; error: "payment-not-found" | "payment-not-successful" | "ambiguous-payment" }> {
  let res: Response;
  try {
    res = await fetchImpl(`${MIRROR_BASE}/transactions/${dashTxId}`, { cache: "no-store" });
  } catch {
    return { ok: false, error: "payment-not-found" };
  }
  if (res.status === 404) return { ok: false, error: "payment-not-found" };
  if (!res.ok) return { ok: false, error: "payment-not-found" };
  let body: { transactions?: MirrorTx[] };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, error: "payment-not-found" };
  }
  const tx = body?.transactions?.[0];
  if (!tx) return { ok: false, error: "payment-not-found" };
  if (tx.result !== "SUCCESS") return { ok: false, error: "payment-not-successful" };

  // Token path first: exactly one token with positive transfers.
  const positiveTokens = (tx.token_transfers ?? [])
    .map((t) => ({ token_id: t.token_id, account: t.account, amount: toBigInt(t.amount) }))
    .filter((t) => t.amount !== null && t.amount > 0n) as Array<{ token_id: string; account: string; amount: bigint }>;
  const tokenIds = [...new Set(positiveTokens.map((t) => t.token_id))];
  if (tokenIds.length > 1) return { ok: false, error: "ambiguous-payment" };
  if (tokenIds.length === 1) {
    const id = tokenIds[0];
    const ofToken = (tx.token_transfers ?? []).filter((t) => t.token_id === id);
    const credits = ofToken
      .map((t) => ({ account: t.account, amount: toBigInt(t.amount) }))
      .filter((t): t is { account: string; amount: bigint } => t.amount !== null && t.amount > 0n)
      .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
    const debits = ofToken
      .map((t) => ({ account: t.account, amount: toBigInt(t.amount) }))
      .filter((t): t is { account: string; amount: bigint } => t.amount !== null && t.amount < 0n)
      .sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
    if (credits.length === 0 || debits.length === 0) return { ok: false, error: "ambiguous-payment" };
    return {
      ok: true,
      payment: {
        payer: debits[0].account,
        payee: credits[0].account,
        amount: credits[0].amount,
        asset: id,
        consensusTimestamp: tx.consensus_timestamp ?? "",
      },
    };
  }

  // HBAR path: largest debit = payer, largest credit = payee.
  const hbar = (tx.transfers ?? [])
    .map((t) => ({ account: t.account, amount: toBigInt(t.amount) }))
    .filter((t) => t.amount !== null) as Array<{ account: string; amount: bigint }>;
  const debits = hbar.filter((t) => t.amount < 0n).sort((a, b) => (a.amount < b.amount ? -1 : 1));
  const credits = hbar.filter((t) => t.amount > 0n).sort((a, b) => (b.amount > a.amount ? 1 : -1));
  if (debits.length === 0 || credits.length === 0) return { ok: false, error: "ambiguous-payment" };
  return {
    ok: true,
    payment: {
      payer: debits[0].account,
      payee: credits[0].account,
      amount: credits[0].amount,
      asset: "HBAR",
      consensusTimestamp: tx.consensus_timestamp ?? "",
    },
  };
}

export interface AttestArgs {
  /** Raw transaction id (SDK @ form or dash form). */
  paymentTxId: string;
  state: AttestState;
  /** Wallet address from the verified session. */
  wallet: string;
  note?: string;
}

export interface AttestDeps {
  store?: KvStore;
  fetchImpl?: FetchFn;
  nowMs?: number;
}

/**
 * Attest an obligation state for a settled payment. The payment is verified
 * against the mirror node; the session wallet must be the side of the
 * payment allowed to attest the requested state. Never throws — returns
 * { ok:false } instead.
 */
export async function attestObligation(
  args: AttestArgs,
  deps: AttestDeps = {},
): Promise<AttestResult> {
  const store = deps.store ?? getKvStore();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowMs = deps.nowMs ?? Date.now();
  const fail = (error: AttestError, detail: string): AttestResult => ({ ok: false, error, detail });

  const norm = normalizeTxId(args.paymentTxId);
  if (!norm.ok) return fail("bad-tx-id", "unrecognized transaction id format");
  // Mirror /transactions needs the dash form; normalizeTxId keeps EVM hashes as-is.
  const dashTxId = norm.txId; // normalizeTxId already returns the dash form for SDK ids

  if (args.state !== "fulfilled" && args.state !== "disputed" && args.state !== "refunded") {
    return fail("bad-state", "state must be fulfilled, disputed, or refunded");
  }
  const wallet = args.wallet.trim();
  if (!wallet) return fail("not-a-counterparty", "missing wallet");
  let note: string | null = null;
  if (args.note !== undefined) {
    note = args.note.trim().slice(0, MAX_NOTE_LEN) || null;
  }

  // Rate limit: bounded writes per wallet per day.
  try {
    const n = await store.incr(`${OBLIGATION_RL_PREFIX}${wallet}`, RL_TTL_MS);
    if (n > RL_MAX_PER_DAY) return fail("rate-limited", "too many attestations today — try again tomorrow");
  } catch {
    return fail("unavailable", "temporarily unavailable — try again in a moment");
  }

  // The payment must exist with consensus SUCCESS — never attest vapor.
  const settled = await fetchSettledPayment(dashTxId, fetchImpl);
  if (!settled.ok) {
    const detail =
      settled.error === "payment-not-found"
        ? "transaction not found on the mirror node — it may still be pending"
        : settled.error === "payment-not-successful"
          ? "transaction did not reach consensus SUCCESS"
          : "payment transfers are ambiguous — refusing to guess";
    return fail(settled.error, detail);
  }
  const p = settled.payment;

  // Authorization: the wallet must be the side allowed to attest this state.
  const side = ATTEST_SIDE[args.state];
  const expected = side === "payer" ? p.payer : p.payee;
  if (wallet.toLowerCase() !== expected.toLowerCase()) {
    return fail(
      "not-a-counterparty",
      `only the ${side} (${expected}) can attest ${args.state} for this payment`,
    );
  }

  const key = `${OBLIGATION_KEY_PREFIX}${dashTxId}`;
  let record: ObligationRecord | null = null;
  try {
    const raw = await store.get(key);
    if (raw) record = JSON.parse(raw) as ObligationRecord;
  } catch {
    return fail("unavailable", "temporarily unavailable — try again in a moment");
  }

  const nowIso = new Date(nowMs).toISOString();
  if (!record) {
    record = {
      payment_tx_id: dashTxId,
      payer: p.payer,
      payee: p.payee,
      amount: p.amount.toString(),
      asset: p.asset,
      consensus_timestamp: p.consensusTimestamp,
      hashscan: `${HASHSCAN_TX_BASE}/${dashTxId}`,
      state: "settled",
      attestations: [],
      created_at: nowIso,
      updated_at: nowIso,
    };
  }

  const allowed = TRANSITIONS[record.state];
  if (!allowed.includes(args.state)) {
    return fail(
      "terminal-state",
      record.state === args.state
        ? `already ${record.state} — terminal states can't be re-attested`
        : `can't move from ${record.state} to ${args.state}`,
    );
  }

  record.attestations.push({ state: args.state, attested_by: wallet, attested_at: nowIso, note });
  record.state = args.state;
  record.updated_at = nowIso;
  try {
    await store.set(key, JSON.stringify(record), OBLIGATION_TTL_MS);
  } catch {
    return fail("unavailable", "temporarily unavailable — try again in a moment");
  }
  return { ok: true, record };
}

/** Public read: the obligation lifecycle for one payment transaction, or null. */
export async function getObligation(
  paymentTxId: string,
  store: KvStore = getKvStore(),
): Promise<ObligationRecord | null> {
  const norm = normalizeTxId(paymentTxId);
  if (!norm.ok) return null;
  const dashTxId = norm.txId; // normalizeTxId already returns the dash form for SDK ids
  try {
    const raw = await store.get(`${OBLIGATION_KEY_PREFIX}${dashTxId}`);
    if (!raw) return null;
    return JSON.parse(raw) as ObligationRecord;
  } catch {
    return null;
  }
}
