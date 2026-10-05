/**
 * Voicescape MCP — Agent Tipping Review (bounded review tools, MVP).
 *
 * `review_agent_tipping` returns a deterministic verdict over an agent's
 * on-chain tipping behavior: clean / flagged / insufficient_data, with
 * mirror-node evidence and a prepared (unsigned) HCS attestation
 * transaction the caller signs to commit the review publicly.
 *
 * Design constraints (deliberate):
 * - Deterministic, not semantic: for on-chain records a reproducible check
 *   beats an LLM opinion. Every verdict cites its evidence.
 * - The server NEVER signs. The attestation tx is built, frozen, and
 *   returned unsigned — the caller (e.g. hunter's agent) signs with their
 *   own identity, making them the independent attestor of our review.
 * - No new dependencies: @hiero-ledger/sdk and the mirror node patterns
 *   already in mcp-tools.ts.
 */

import { createHash } from "node:crypto";
import {
  AccountId,
  Timestamp,
  TopicId,
  TopicMessageSubmitTransaction,
  TransactionId,
} from "@hiero-ledger/sdk";
import { MIRROR_BASE } from "./mcp-tools";
import { TIPS_CONTRACT_ID, tinybarToHbar } from "../tx-proof";

export type TippingVerdict = "clean" | "flagged" | "insufficient_data";

export interface TipEvidence {
  transaction_id: string;
  amount_hbar: string;
  recipient: string;
  consensus_timestamp: string;
  hashscan: string;
  self_tip: boolean;
}

export interface TippingReview {
  subject: string;
  subject_account: string | null;
  review_type: "tipping_behavior";
  verdict: TippingVerdict;
  confidence: "high" | "medium" | "low";
  summary: string;
  tips_analyzed: number;
  total_tipped_hbar: string;
  self_tip_count: number;
  evidence: TipEvidence[];
  checked_at: string;
  reviewer: string;
  /** SHA256 hex of the canonical report JSON (without this field). */
  report_hash: string;
  /** Unsigned HCS attestation tx (base64) for the caller to sign + submit. */
  attestation_tx_base64: string | null;
  attestation_note: string;
}

/** Recommended HCS topic for review attestations (caller may use their own). */
export const REVIEW_ATTESTATION_TOPIC = "0.0.0"; // placeholder until topic is created

/**
 * Brandon's public treasury — receives the 2% tip cut. Excluded when
 * matching the true tip recipient from transfer records.
 */
const TREASURY_ACCOUNT_ID = "0.0.10424063";

const REVIEWER_ID = "io.github.VoiceScapee/voicescape";

/** Minimum tips needed for a high-confidence verdict. */
const MIN_TIPS_FOR_VERDICT = 3;

interface MirrorTx {
  /** 0x transaction hash, or "" when the row has no usable hash. */
  tx_hash: string;
  consensus_timestamp: string;
  /** HBAR value sent with the tipPage call, in tinybar. */
  amount_tinybar: number;
}

async function fetchJson(
  fetchFn: typeof fetch,
  url: string,
): Promise<{ ok: boolean; body?: any }> {
  try {
    const res = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false };
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false };
  }
}

/**
 * Resolve a username to its Hedera account, or accept a raw 0.0.x account
 * id directly. Username resolution is not wired — the caller must pass a
 * 0.0.x account id. Fails fast with no network call.
 */
function resolveSubject(subject: string): string | null {
  const trimmed = subject.trim();
  if (/^0\.0\.\d+$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Fetch recent successful tipPage calls FROM the subject account by
 * scanning the Tips contract results and filtering by sender.
 * The subject's EVM address is resolved first so we can match the
 * `from` field in contract results.
 */
async function fetchTipsFrom(
  accountId: string,
  fetchFn: typeof fetch,
  scanLimit = 200,
): Promise<MirrorTx[]> {
  // Resolve the account's EVM address for sender matching. Note: contract
  // results `from` may be the EVM address OR the 0x-padded account number
  // (e.g. 0x0000...09f0eff for 0.0.10424063) — match both forms.
  const acct = await fetchJson(fetchFn, `${MIRROR_BASE}/accounts/${accountId}`);
  const evmAddress: string =
    typeof acct.body?.evm_address === "string"
      ? acct.body.evm_address.toLowerCase()
      : "";
  const accountNum = accountId.split(".")[2] ?? "";
  const paddedForm = "0x" + BigInt(accountNum).toString(16).padStart(40, "0");
  if (!evmAddress && !paddedForm) return [];

  const { ok, body } = await fetchJson(
    fetchFn,
    `${MIRROR_BASE}/contracts/${TIPS_CONTRACT_ID}/results?limit=${scanLimit}&order=desc`,
  );
  if (!ok || !Array.isArray(body?.results)) return [];
  const out: MirrorTx[] = [];
  for (const row of body.results as Array<Record<string, any>>) {
    if (row.error_message) continue;
    const from: string =
      typeof row.from === "string" ? row.from.toLowerCase() : "";
    if (from !== evmAddress && from !== paddedForm) continue;
    const hash = typeof row.hash === "string" ? row.hash : "";
    // Contract-result `amount` is the HBAR sent with the tipPage call.
    const amountTinybar = Math.max(0, Math.round(Number(row.amount ?? 0)));
    out.push({
      tx_hash: hash,
      consensus_timestamp: String(row.timestamp ?? ""),
      amount_tinybar: amountTinybar,
    });
  }
  return out;
}

interface MirrorTransfer {
  account?: string;
  amount?: number;
}

/**
 * Resolve the true tip recipient for one tip transaction via its
 * mirror-node record. The Tips contract splits atomically — 98% to the
 * page owner, 2% to treasury — so the recipient is the largest credit
 * that is neither the contract itself nor the treasury.
 * Returns null when the record can't be fetched; the caller records
 * the recipient as "unknown" rather than guessing.
 */
async function resolveTipRecipient(
  txHash: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  if (!/^0x[0-9a-fA-F]+$/.test(txHash)) return null;
  const { ok, body } = await fetchJson(
    fetchFn,
    `${MIRROR_BASE}/transactions/${txHash}`,
  );
  if (!ok) return null;
  const tx = body?.transactions?.[0] ?? body;
  const transfers: MirrorTransfer[] = Array.isArray(tx?.transfers)
    ? tx.transfers
    : [];
  let best: string | null = null;
  let bestAmount = 0;
  for (const tr of transfers) {
    const acct = typeof tr.account === "string" ? tr.account : "";
    const amt = typeof tr.amount === "number" ? tr.amount : 0;
    if (!acct || amt <= 0) continue;
    if (acct === TIPS_CONTRACT_ID || acct === TREASURY_ACCOUNT_ID) continue;
    if (amt > bestAmount) {
      bestAmount = amt;
      best = acct;
    }
  }
  return best;
}

/** Recursively sort object keys so the hash commits to nested evidence too. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeysDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Canonical JSON for hashing: stable key order at every depth, no whitespace. */
function canonicalReport(report: Omit<TippingReview, "report_hash" | "attestation_tx_base64" | "attestation_note">): string {
  return JSON.stringify(sortKeysDeep(report));
}

export function hashReport(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Build an UNSIGNED HCS attestation transaction committing the report
 * hash. The caller signs with their own key and submits — they become
 * the attestor of our review.
 *
 * Returns base64 of the frozen (unsigned) transaction bytes, or null if
 * the topic is not yet configured.
 */
export async function buildAttestationTx(
  topicId: string,
  reportHash: string,
  subject: string,
  verdict: TippingVerdict,
): Promise<string | null> {
  if (!topicId || topicId === "0.0.0") return null;
  try {
    const message = JSON.stringify({
      type: "voicescape.tipping_review.v1",
      reviewer: REVIEWER_ID,
      subject,
      verdict,
      report_hash: reportHash,
      attested_at: new Date().toISOString(),
    });
    const tx = new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(message)
      // Payer is left unset — the signing caller sets their own account.
      .setTransactionId(TransactionId.generate(AccountId.fromString("0.0.0")))
      .setNodeAccountIds([AccountId.fromString("0.0.3")])
      .freeze();
    return Buffer.from(tx.toBytes()).toString("base64");
  } catch {
    return null;
  }
}

/**
 * Review an agent's on-chain tipping behavior.
 *
 * @param subject Hedera account id (0.0.x). Username resolution is not
 *   yet wired — pass the account directly.
 */
export async function reviewAgentTipping(
  subject: string,
  fetchFn: typeof fetch = fetch,
  attestationTopic: string = REVIEW_ATTESTATION_TOPIC,
): Promise<TippingReview | { error: string }> {
  const accountId = resolveSubject(subject);
  if (!accountId) {
    return {
      error:
        "could not resolve subject to a Hedera account — pass a 0.0.x account id directly (username resolution coming soon)",
    };
  }

  const tips = await fetchTipsFrom(accountId, fetchFn);
  const checkedAt = new Date().toISOString();

  // Bound the per-tip record lookups: 20 is plenty for a verdict and
  // keeps the tool's mirror-node call count sane.
  const sample = tips.slice(0, 20);
  const recipients = await Promise.all(
    sample.map((t) => resolveTipRecipient(t.tx_hash, fetchFn)),
  );

  let selfTips = 0;
  let whaleTips = 0;
  let totalTinybar = BigInt(0);
  const evidence: TipEvidence[] = [];

  const WHALE_TINYBAR = 100 * 100_000_000;
  sample.forEach((t, i) => {
    const amount = t.amount_tinybar;
    const recipient = recipients[i] ?? "unknown";
    const txHash = t.tx_hash;
    const isSelf = recipient === accountId;
    if (isSelf) selfTips++;
    if (amount > WHALE_TINYBAR) whaleTips++;
    totalTinybar += BigInt(amount);
    evidence.push({
      transaction_id: txHash || `ts:${t.consensus_timestamp}`,
      amount_hbar: tinybarToHbar(BigInt(amount)),
      recipient,
      consensus_timestamp: t.consensus_timestamp,
      hashscan: txHash
        ? `https://hashscan.io/mainnet/transaction/${txHash}`
        : "",
      self_tip: isSelf,
    });
  });

  // Verdict logic (deterministic, documented):
  // - insufficient_data: fewer than MIN_TIPS_FOR_VERDICT tips observed.
  // - flagged: self-tip rate >= 50% (wash pattern) OR any single tip
  //   exceeds 100 HBAR (anomaly worth human review).
  // - clean: otherwise.
  const n = sample.length;
  let verdict: TippingVerdict;
  let confidence: TippingReview["confidence"];
  let summary: string;

  if (tips.length < MIN_TIPS_FOR_VERDICT) {
    verdict = "insufficient_data";
    confidence = "low";
    summary = `only ${tips.length} tip(s) observed for ${accountId} — not enough history for a verdict`;
  } else if (selfTips * 2 >= n) {
    verdict = "flagged";
    confidence = "high";
    summary = `${selfTips} of ${n} tips are self-tips — possible wash pattern`;
  } else if (whaleTips > 0) {
    verdict = "flagged";
    confidence = "medium";
    summary = `${whaleTips} tip(s) exceed 100 HBAR — anomaly worth human review`;
  } else {
    verdict = "clean";
    confidence = n >= 10 ? "high" : "medium";
    summary = `${n} tips totaling ${tinybarToHbar(totalTinybar)} HBAR, no wash pattern detected`;
  }

  const reportBase = {
    subject,
    subject_account: accountId,
    review_type: "tipping_behavior" as const,
    verdict,
    confidence,
    summary,
    tips_analyzed: n,
    total_tipped_hbar: tinybarToHbar(totalTinybar),
    self_tip_count: selfTips,
    evidence,
    checked_at: checkedAt,
    reviewer: REVIEWER_ID,
  };
  const reportHash = hashReport(canonicalReport(reportBase));
  const attestationTx = await buildAttestationTx(
    attestationTopic,
    reportHash,
    subject,
    verdict,
  );

  return {
    ...reportBase,
    report_hash: reportHash,
    attestation_tx_base64: attestationTx,
    attestation_note: attestationTx
      ? "unsigned HCS attestation tx — sign with your key and submit to commit this review publicly; you become the attestor"
      : "attestation topic not yet configured — verdict and evidence above are still fully verifiable via the mirror node",
  };
}
