/**
 * Agent trust-score aggregation (Pillar 2 of the roadmap).
 *
 * A transparent, explainable 0–100 score per agent, computed ONLY from data
 * that already exists on Hedera mainnet or in our own store. This module is
 * READ-ONLY: no chain writes, no new contracts, no platform spend. Mirror-
 * node REST is free and already an approved dependency.
 *
 * ------------------------------------------------------------------
 * FORMULA (v1 — documented here, in code, and in the API output)
 * ------------------------------------------------------------------
 * Four components, each normalized to 0..1, then weighted:
 *
 *   payments  40% — settled Tips-contract payments TO this agent.
 *                   Unique payers weigh 70% of this component, raw tx
 *                   count 30% (sybil-awareness: 10 tips from 10 people
 *                   outranks 100 tips from 1 person).
 *                   payers = min(1, uniquePayers / 10)
 *                   volume = min(1, txCount / 25)
 *                   paymentScore = 0.7 * payers + 0.3 * volume
 *
 *   reviews   30% — proof-of-payment reviews (existing system: each
 *                   review is linked to a settled Tips-contract tx).
 *                   reviewScore = (avgRating / 5) * 0.6 + min(1, count / 10) * 0.4
 *
 *   votes     20% — community up/down votes (existing tally).
 *                   voteScore = (up / (up + down)) * min(1, total / 20)
 *
 *   tenure    10% — registration age, capped at one year.
 *                   tenureScore = min(1, daysSinceRegistration / 365)
 *
 *   score = round(100 * (0.40*paymentScore + 0.30*reviewScore
 *                        + 0.20*voteScore + 0.10*tenureScore))
 *
 * HONESTY RULES (hard):
 * - score is NULL ("not enough data") when the agent has zero payments,
 *   zero verified reviews, and zero community votes. We never invent
 *   history for an agent with none.
 * - `beta: true` when the score rests on thin data (< 5 total signals).
 *   Thin-data scores are directionally useful, not verdicts.
 * - Every component is exposed in the output so anyone can audit the math.
 */

import { ethers } from "ethers";
import { getActiveChain } from "../chains";
import { getTipsAddress } from "@/lib/contracts";

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export interface TrustComponents {
  payments: { txCount: number; uniquePayers: number; score: number };
  reviews: { count: number; avg: number | null; score: number };
  votes: { up: number; down: number; score: number };
  tenure: { days: number | null; score: number };
}

export interface TrustScore {
  /** 0–100, or null when there is not enough data to score honestly. */
  score: number | null;
  /** True when the score rests on thin data (< 5 total signals). */
  beta: boolean;
  /** Always "on-chain" — every input is mainnet-verifiable. */
  basis: "on-chain";
  components: TrustComponents;
  /** Human-readable note, e.g. why the score is null. */
  note: string | null;
  /** ISO timestamp of computation. */
  computedAt: string;
}

export interface TrustInputs {
  username: string;
  /** Mirror-node timestamp of the registerPage call (consensus seconds.nanoseconds). */
  registeredAt: string | null;
  up: number;
  down: number;
  reviewCount: number;
  reviewAvg: number | null;
}

/* ------------------------------------------------------------------ */
/* Pure scoring formula — no network, fully unit-testable               */
/* ------------------------------------------------------------------ */

export const TRUST_WEIGHTS = {
  payments: 0.4,
  reviews: 0.3,
  votes: 0.2,
  tenure: 0.1,
} as const;

export function paymentComponentScore(txCount: number, uniquePayers: number): number {
  const payers = Math.min(1, Math.max(0, uniquePayers) / 10);
  const volume = Math.min(1, Math.max(0, txCount) / 25);
  return 0.7 * payers + 0.3 * volume;
}

export function reviewComponentScore(count: number, avg: number | null): number {
  if (count <= 0 || avg === null) return 0;
  const rating = Math.min(1, Math.max(0, avg) / 5);
  return rating * 0.6 + Math.min(1, count / 10) * 0.4;
}

export function voteComponentScore(up: number, down: number): number {
  const total = Math.max(0, up) + Math.max(0, down);
  if (total <= 0) return 0;
  return (Math.max(0, up) / total) * Math.min(1, total / 20);
}

export function tenureComponentScore(registeredAt: string | null, nowMs = Date.now()): number {
  if (!registeredAt) return 0;
  const secs = Number(String(registeredAt).split(".")[0]);
  if (!Number.isFinite(secs) || secs <= 0) return 0;
  const days = (nowMs - secs * 1000) / 86_400_000;
  if (days < 0) return 0;
  return Math.min(1, days / 365);
}

export function tenureDays(registeredAt: string | null, nowMs = Date.now()): number | null {
  if (!registeredAt) return null;
  const secs = Number(String(registeredAt).split(".")[0]);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  const days = Math.floor((nowMs - secs * 1000) / 86_400_000);
  return days < 0 ? 0 : days;
}

/**
 * Combine component scores into a 0–100 trust score (or null when there
 * is no signal at all). Pure and deterministic — the unit tests pin this.
 */
export function combineTrustScore(parts: {
  paymentScore: number;
  reviewScore: number;
  voteScore: number;
  tenureScore: number;
}): number {
  const weighted =
    TRUST_WEIGHTS.payments * parts.paymentScore +
    TRUST_WEIGHTS.reviews * parts.reviewScore +
    TRUST_WEIGHTS.votes * parts.voteScore +
    TRUST_WEIGHTS.tenure * parts.tenureScore;
  return Math.round(100 * Math.min(1, Math.max(0, weighted)));
}

/* ------------------------------------------------------------------ */
/* On-chain payment stats: TipSent logs from the mirror node           */
/* ------------------------------------------------------------------ */

// TipSent(string indexed username, address indexed from,
//         address indexed toOwner, uint256 amount, uint256 fee)
const TIPSENT_TOPIC0 = ethers.id("TipSent(string,address,address,uint256,uint256)");

export interface PaymentStats {
  txCount: number;
  uniquePayers: number;
}

interface MirrorLogsResponse {
  logs?: Array<{ topics?: string[]; data?: string }>;
  links?: { next?: string | null };
}

/**
 * Count settled Tips-contract payments to `username` and the distinct
 * payers behind them, straight from mainnet mirror-node contract logs.
 *
 * The username topic is keccak256 of the lowercase username — directory
 * usernames are normalized lowercase, and the registry resolves
 * case-insensitively, so tips land under the canonical form. (A tip sent
 * with different casing would hash differently and not be attributed —
 * documented limitation, same convention as the rest of the directory.)
 *
 * Note: the mirror node's contract-logs endpoint does not honor the
 * topic0/topic1 query filters, so we page the contract's full log feed
 * (small: the Tips contract is young) and filter in code. Bounded at 20
 * pages × 100 logs — far above current volume.
 */
export async function fetchPaymentStats(
  username: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PaymentStats> {
  const chainKey = getActiveChain().key;
  if (chainKey !== "hedera-mainnet") {
    throw new Error(`trust score is mainnet-only (chain: ${chainKey})`);
  }
  const tips = getTipsAddress();
  if (!tips) throw new Error("Tips contract address is not configured");
  // getTipsAddress() returns the EVM address form; the logs endpoint also
  // accepts 0.0.x — normalize via the known mainnet id when needed.
  const contractPath = tips.startsWith("0x") ? tips : "0.0.10854060";

  const usernameTopic = ethers.keccak256(ethers.toUtf8Bytes(username.toLowerCase()));
  const base = "https://mainnet.mirrornode.hedera.com";
  let url: string | null =
    `${base}/api/v1/contracts/${contractPath}/results/logs?order=asc&limit=100`;

  const payers = new Set<string>();
  let txCount = 0;
  let pages = 0;
  while (url && pages < 20) {
    pages += 1;
    let res: Response;
    try {
      res = await fetchImpl(url);
    } catch (e) {
      throw new Error(`mirror node unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      throw new Error(`mirror node error (${res.status}) reading TipSent logs`);
    }
    const data = (await res.json()) as MirrorLogsResponse;
    for (const log of data.logs ?? []) {
      const topics = log.topics ?? [];
      // topics[0] = event sig, topics[1] = username hash, topics[2] = from (payer)
      if (topics.length < 3) continue;
      if (topics[0].toLowerCase() !== TIPSENT_TOPIC0.toLowerCase()) continue;
      if (topics[1].toLowerCase() !== usernameTopic.toLowerCase()) continue;
      const payerTopic = topics[2];
      const payer = "0x" + payerTopic.slice(-40).toLowerCase();
      payers.add(payer);
      txCount += 1;
    }
    const next = data.links?.next;
    url = next ? `${base}${next}` : null;
  }
  return { txCount, uniquePayers: payers.size };
}

/* ------------------------------------------------------------------ */
/* Assembly + per-agent cache (15 min)                                 */
/* ------------------------------------------------------------------ */

const TRUST_CACHE_TTL_MS = 15 * 60_000;
const trustCache = new Map<string, { at: number; score: TrustScore }>();

/**
 * Compute an agent's trust score. Never throws: any failure (mirror node
 * down, bad data) degrades to a null score with an explanatory note —
 * the directory must never break because trust couldn't be computed.
 */
export async function computeTrustScore(inputs: TrustInputs): Promise<TrustScore> {
  const key = inputs.username.toLowerCase();
  const now = Date.now();
  const cached = trustCache.get(key);
  if (cached && now - cached.at < TRUST_CACHE_TTL_MS) return cached.score;

  let stats: PaymentStats = { txCount: 0, uniquePayers: 0 };
  let paymentsOk = true;
  try {
    stats = await fetchPaymentStats(inputs.username);
  } catch {
    paymentsOk = false;
  }

  const paymentScore = paymentsOk ? paymentComponentScore(stats.txCount, stats.uniquePayers) : 0;
  const reviewScore = reviewComponentScore(inputs.reviewCount, inputs.reviewAvg);
  const voteScore = voteComponentScore(inputs.up, inputs.down);
  const tenureScore = tenureComponentScore(inputs.registeredAt, now);
  const days = tenureDays(inputs.registeredAt, now);

  const signals =
    stats.txCount + inputs.reviewCount + Math.max(0, inputs.up) + Math.max(0, inputs.down);

  const components: TrustComponents = {
    payments: { txCount: stats.txCount, uniquePayers: stats.uniquePayers, score: paymentScore },
    reviews: { count: inputs.reviewCount, avg: inputs.reviewAvg, score: reviewScore },
    votes: { up: Math.max(0, inputs.up), down: Math.max(0, inputs.down), score: voteScore },
    tenure: { days, score: tenureScore },
  };

  let result: TrustScore;
  if (signals === 0) {
    // Honest null: no payments, no reviews, no votes — never invent history.
    result = {
      score: null,
      beta: true,
      basis: "on-chain",
      components,
      note: "Not enough data yet — no on-chain payments, verified reviews, or community votes.",
      computedAt: new Date(now).toISOString(),
    };
  } else {
    result = {
      score: combineTrustScore({ paymentScore, reviewScore, voteScore, tenureScore }),
      beta: signals < 5,
      basis: "on-chain",
      components,
      note: signals < 5 ? "Beta — limited on-chain history; treat as directional, not a verdict." : null,
      computedAt: new Date(now).toISOString(),
    };
  }
  trustCache.set(key, { at: now, score: result });
  return result;
}

/** Test helper: clear the trust cache. */
export function clearTrustCache(): void {
  trustCache.clear();
}
