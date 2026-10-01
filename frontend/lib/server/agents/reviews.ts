/**
 * Voicescape — proof-of-payment reviews for agents.
 *
 * Community votes are explicitly NOT proof-of-payment (see agents-directory).
 * Reviews in this module ARE: every review is cryptographically tied to one
 * settled Tips-contract transaction (a TipSent tip or a PurchaseCompleted
 * marketplace sale), verified live against the Hedera mainnet mirror node.
 *
 * The Tips contract is the source of truth: TipSent is emitted only after
 * the atomic 98/2 tip transfers succeed; PurchaseCompleted only after the
 * atomic 98/2 sale settles. An event log from the contract for THIS
 * transaction, naming the reviewer's wallet as sender and the agent's page
 * owner as recipient, is the proof. Nothing is invented — verification
 * fails closed (503/422) whenever the mirror node can't confirm.
 *
 * Storage is the shared KV store (Upstash/Valkey in production, in-memory
 * fallback in dev): one JSON array per agent username, capped at 200,
 * newest first, 10-year TTL. One review per transaction id, claimed
 * atomically with setNx so the same payment can never mint two reviews.
 *
 * Privacy: only the reviewer's wallet address (already public on-chain in
 * the proven transaction) and their page username (best-effort) are stored.
 * Never IPs, never anything else.
 */

import { ethers } from "ethers";
import { getKvStore } from "../store";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface VerifiedReview {
  /** Canonical 0.0.x@seconds.nanos form of the proven transaction. */
  txId: string;
  /** "tip" (TipSent) or "purchase" (PurchaseCompleted). */
  kind: "tip" | "purchase";
  /** Reviewer's wallet, canonical lowercase 0x. */
  reviewer: string;
  /** Reviewer's page username when resolvable at write time, else null. */
  reviewerUsername: string | null;
  /** Integer 1–5. */
  rating: number;
  /** Review text, trimmed, max 500 chars. May be empty. */
  text: string;
  /** ISO timestamp of when the review was stored. */
  timestamp: string;
}

export interface ReviewSummary {
  count: number;
  /** Mean rating, rounded to 1 decimal. */
  avg: number;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** keccak256("TipSent(string,address,address,uint256,uint256)") — topics[0]. */
const TIPSENT_TOPIC0 = ethers.id("TipSent(string,address,address,uint256,uint256)");
/** keccak256("PurchaseCompleted(address,address,string,uint256,uint256)") — topics[0]. */
const PURCHASE_COMPLETED_TOPIC0 = ethers.id(
  "PurchaseCompleted(address,address,string,uint256,uint256)",
);

/** KV key holding the JSON review array for one agent (lowercased username). */
const reviewsKey = (username: string) => `agent:reviews:${username.toLowerCase()}`;
 /** KV key atomically claiming one transaction id for a single review. */
const claimKey = (txId: string) => `review:tx:${txId.toLowerCase()}`;

/** Cap on stored reviews per agent — the list never grows unbounded. */
export const MAX_REVIEWS_PER_AGENT = 200;
/** Reviews are durable user content: 10-year TTL (the store's durable pattern). */
export const REVIEW_TTL_MS = 10 * 365 * 24 * 3600 * 1000;
/** GET pagination bound. */
export const MAX_REVIEW_LIMIT = 50;
/** Review text bound. */
export const MAX_REVIEW_TEXT = 500;

/* ------------------------------------------------------------------ */
/* Transaction id parsing                                              */
/* ------------------------------------------------------------------ */

/**
 * Normalize a Hedera transaction id to canonical `0.0.x@seconds.nanos`.
 * Accepts the @-form and the dash-form (`0.0.x-seconds-nanos`).
 * Returns null for anything else.
 */
export function normalizeTxId(txId: unknown): string | null {
  if (typeof txId !== "string") return null;
  const m = /^(\d+\.\d+\.\d+)[@-](\d+)[.-](\d+)$/.exec(txId.trim());
  if (!m) return null;
  return `${m[1]}@${m[2]}.${m[3]}`;
}

/** Dash-form for mirror-node URL paths: `0.0.x-seconds-nanos`. */
function txIdToPathForm(canonical: string): string {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(canonical);
  if (!m) return canonical;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/* ------------------------------------------------------------------ */
/* Input validation (pure)                                             */
/* ------------------------------------------------------------------ */

export interface ReviewInput {
  txId: string;
  rating: number;
  text: string;
}

export type InputCheck =
  | { ok: true; input: ReviewInput }
  | { ok: false; error: string };

/**
 * Validate the review body. Pure — no I/O, directly unit-testable.
 */
export function validateReviewInput(body: unknown): InputCheck {
  if (!body || typeof body !== "object") return { ok: false, error: "invalid JSON body" };
  const b = body as Record<string, unknown>;
  const txId = normalizeTxId(b.txId);
  if (!txId) {
    return { ok: false, error: "txId must be a Hedera transaction id (0.0.x@seconds.nanos)" };
  }
  if (typeof b.rating !== "number" || !Number.isInteger(b.rating) || b.rating < 1 || b.rating > 5) {
    return { ok: false, error: "rating must be an integer from 1 to 5" };
  }
  if (typeof b.text !== "string") return { ok: false, error: "text must be a string" };
  const text = b.text.trim();
  if (text.length > MAX_REVIEW_TEXT) {
    return { ok: false, error: `text must be at most ${MAX_REVIEW_TEXT} characters` };
  }
  return { ok: true, input: { txId, rating: b.rating, text } };
}

/* ------------------------------------------------------------------ */
/* On-chain verification                                               */
/* ------------------------------------------------------------------ */

export interface VerifyDeps {
  fetchFn: typeof fetch;
  mirrorBaseUrl: string;
  /** Tips contract address, 0.0.x form. */
  tipsAddress: string;
}

export type VerifyResult =
  | { ok: true; kind: "tip" | "purchase"; sender: string }
  /** status is the HTTP status the route should answer with. */
  | { ok: false; error: string; status: 403 | 404 | 422 | 503 };

interface MirrorTx {
  result?: string;
  name?: string;
  entity_id?: string;
  consensus_timestamp?: string;
  transaction_hash?: string;
}

function topicAddress(topic: unknown): string | null {
  if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return ("0x" + topic.slice(-40)).toLowerCase();
}

/**
 * Verify that `txId` is a successful Tips-contract call whose TipSent or
 * PurchaseCompleted event proves `sessionAddress` paid the agent page owner
 * `agentOwner` (both canonical lowercase 0x).
 *
 * Fails closed: any mirror-node failure is a 503, any proof failure is a
 * 422/403 — never a fabricated "verified".
 */
export async function verifyReviewTx(
  txId: string,
  sessionAddress: string,
  agentOwner: string,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const { fetchFn, mirrorBaseUrl, tipsAddress } = deps;
  const base = mirrorBaseUrl.replace(/\/$/, "");

  // 1. The transaction itself: must exist, be successful, and be a call to
  // the Tips contract.
  let txRes: Response;
  try {
    txRes = await fetchFn(`${base}/api/v1/transactions/${txIdToPathForm(txId)}`, {
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    return { ok: false, error: "mirror node unreachable — try again in a moment", status: 503 };
  }
  if (txRes.status === 404) {
    return { ok: false, error: "transaction not found on Hedera mainnet", status: 404 };
  }
  if (!txRes.ok) {
    return { ok: false, error: "mirror node error reading the transaction", status: 503 };
  }
  let tx: MirrorTx;
  try {
    const data = (await txRes.json()) as { transactions?: MirrorTx[] };
    tx = data.transactions?.[0] ?? {};
  } catch {
    return { ok: false, error: "mirror node returned an unreadable transaction", status: 503 };
  }
  if (tx.result !== "SUCCESS") {
    return { ok: false, error: "transaction was not successful — only settled payments prove a review", status: 422 };
  }
  if (tx.name !== "CONTRACTCALL" || tx.entity_id !== tipsAddress) {
    return { ok: false, error: "transaction is not a call to the Voicescape Tips contract", status: 422 };
  }
  if (!tx.transaction_hash) {
    return { ok: false, error: "transaction has no hash to verify against", status: 503 };
  }

  // 2. The contract result's event logs for THIS transaction — the proof
  // lives here, not in our database.
  let logsRes: Response;
  try {
    logsRes = await fetchFn(`${base}/api/v1/contracts/results/${tx.transaction_hash}`, {
      headers: { Accept: "application/json" },
    });
  } catch {
    return { ok: false, error: "mirror node unreachable — try again in a moment", status: 503 };
  }
  if (logsRes.status === 404) {
    return { ok: false, error: "contract result not available for this transaction", status: 422 };
  }
  if (!logsRes.ok) {
    return { ok: false, error: "mirror node error reading the contract result", status: 503 };
  }
  let logs: { topics?: unknown[] }[];
  try {
    const data = (await logsRes.json()) as { logs?: { topics?: unknown[] }[] };
    logs = Array.isArray(data.logs) ? data.logs : [];
  } catch {
    return { ok: false, error: "mirror node returned unreadable contract logs", status: 503 };
  }

  // 3. Find the event that proves this reviewer paid this agent's owner.
  for (const log of logs) {
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (typeof topics[0] !== "string") continue;
    const sig = (topics[0] as string).toLowerCase();

    if (sig === TIPSENT_TOPIC0) {
      // TipSent(string indexed username, address indexed from,
      //         address indexed toOwner, uint256 amount, uint256 fee)
      const from = topicAddress(topics[2]);
      const to = topicAddress(topics[3]);
      if (!from || !to) continue;
      if (to !== agentOwner) continue; // tip was for someone else's page
      if (from !== sessionAddress) {
        return { ok: false, error: "this transaction's tip sender does not match your wallet", status: 403 };
      }
      return { ok: true, kind: "tip", sender: from };
    }

    if (sig === PURCHASE_COMPLETED_TOPIC0) {
      // PurchaseCompleted(address indexed buyer, address indexed seller,
      //                   string listingRef, uint256 amount, uint256 fee)
      const buyer = topicAddress(topics[1]);
      const seller = topicAddress(topics[2]);
      if (!buyer || !seller) continue;
      if (seller !== agentOwner) continue; // purchase was from someone else
      if (buyer !== sessionAddress) {
        return { ok: false, error: "this transaction's buyer does not match your wallet", status: 403 };
      }
      return { ok: true, kind: "purchase", sender: buyer };
    }
  }

  return {
    ok: false,
    error: "no tip or completed purchase to this agent in that transaction",
    status: 422,
  };
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

/**
 * Atomically claim one transaction id for a single review. True when this
 * caller won the claim; false when the tx already backed a review.
 * Throws on store failure (fail closed — a claim that cannot be checked
 * must not silently become a duplicate).
 */
export async function claimReviewTx(txId: string): Promise<boolean> {
  return getKvStore().setNx(claimKey(txId), "1", REVIEW_TTL_MS);
}

/** Parse the stored array defensively — corrupt values read as empty. */
function parseReviews(raw: string | null): VerifiedReview[] {
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (r): r is VerifiedReview =>
        !!r &&
        typeof r === "object" &&
        typeof (r as VerifiedReview).txId === "string" &&
        typeof (r as VerifiedReview).reviewer === "string" &&
        typeof (r as VerifiedReview).rating === "number" &&
        typeof (r as VerifiedReview).timestamp === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Append a review for an agent. Newest first, capped at MAX_REVIEWS_PER_AGENT.
 * The caller must have already won claimReviewTx(txId).
 */
export async function addReview(username: string, review: VerifiedReview): Promise<void> {
  const store = getKvStore();
  const key = reviewsKey(username);
  const existing = parseReviews(await store.get(key));
  const next = [review, ...existing].slice(0, MAX_REVIEWS_PER_AGENT);
  await store.set(key, JSON.stringify(next), REVIEW_TTL_MS);
}

/** Mean rating rounded to 1 decimal; null when there are no reviews. */
export function aggregateReviews(reviews: VerifiedReview[]): ReviewSummary | null {
  if (reviews.length === 0) return null;
  const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
  return {
    count: reviews.length,
    avg: Math.round((sum / reviews.length) * 10) / 10,
  };
}

/** The directory's per-agent rollup: null when the agent has no reviews — never fabricated. */
export async function getReviewSummary(username: string): Promise<ReviewSummary | null> {
  const raw = await getKvStore().get(reviewsKey(username));
  return aggregateReviews(parseReviews(raw));
}

export interface ReviewList {
  reviews: VerifiedReview[];
  count: number;
  avg: number | null;
}

/** Public listing: newest first, paginated. */
export async function listReviews(username: string, limit: number): Promise<ReviewList> {
  const raw = await getKvStore().get(reviewsKey(username));
  const all = parseReviews(raw);
  const summary = aggregateReviews(all);
  const safeLimit = Math.max(1, Math.min(MAX_REVIEW_LIMIT, Math.floor(limit) || 20));
  return {
    reviews: all.slice(0, safeLimit),
    count: summary?.count ?? 0,
    avg: summary?.avg ?? null,
  };
}
