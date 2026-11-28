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
import { fetchTipProof, TIPS_CONTRACT_ID, tinybarToHbar, isTipPageCall } from "../tx-proof";

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

/** HCS topic for review attestations ("Voicescape review attestations"). */
export const REVIEW_ATTESTATION_TOPIC = "0.0.10908351";

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
 *
 * Returns the raw rows plus the subject's EVM address in both forms the
 * chain can carry it (alias + long-zero padded account number) so the
 * TipSent recipient can be compared against the payer.
 */
async function fetchTipsFrom(
  accountId: string,
  fetchFn: typeof fetch,
  scanLimit = 200,
): Promise<{ tips: MirrorTx[]; subjectEvm: string; subjectPadded: string }> {
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
  if (!evmAddress && !paddedForm) return { tips: [], subjectEvm: "", subjectPadded: paddedForm };

  const { ok, body } = await fetchJson(
    fetchFn,
    `${MIRROR_BASE}/contracts/${TIPS_CONTRACT_ID}/results?limit=${scanLimit}&order=desc`,
  );
  if (!ok || !Array.isArray(body?.results)) {
    return { tips: [], subjectEvm: evmAddress, subjectPadded: paddedForm };
  }
  const out: MirrorTx[] = [];
  for (const row of body.results as Array<Record<string, any>>) {
    if (row.error_message) continue;
    // Only tipPage calls are tips. Other calls on the same contract
    // (buyListing, contract creation) must never enter the sample: the
    // proof-based exclusion below only fires when the proof read
    // succeeds, so a transient mirror failure used to count the buy as
    // an unresolved tip with its full value. A row whose function is
    // unconfirmed (field missing) is dropped too — fail closed.
    if (!isTipPageCall(row.function_parameters)) continue;
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
  return { tips: out, subjectEvm: evmAddress, subjectPadded: paddedForm };
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

  const { tips, subjectEvm, subjectPadded } = await fetchTipsFrom(accountId, fetchFn);
  const checkedAt = new Date().toISOString();

  // Bound the per-tip record lookups: 20 is plenty for a verdict and
  // keeps the tool's mirror-node call count sane.
  const sample = tips.slice(0, 20);
  // Resolve each sampled call's recipient from its on-chain TipSent event
  // (fetchTipProof decodes the log from /contracts/results/{hash}).
  // The old transfer-based lookup is gone: the mirror node's
  // /transactions/{id} endpoint rejects 0x hashes, so every recipient
  // came back "unknown" and self-tips were never detected (Clearance
  // first pass, 2026-11-27). A call with no TipSent event is not a tip
  // at all (e.g. a marketplace purchase on the same contract) and is
  // excluded from the sample instead of being counted as one.
  const proofs = await Promise.all(
    sample.map((t) => fetchTipProof(t.tx_hash || "", fetchFn)),
  );

  let selfTips = 0;
  let whaleTips = 0;
  let unresolved = 0;
  let analyzed = 0;
  let totalTinybar = BigInt(0);
  const evidence: TipEvidence[] = [];

  const WHALE_TINYBAR = 100 * 100_000_000;
  sample.forEach((t, i) => {
    const proof = proofs[i];
    if (!proof.ok && proof.error === "not-a-tip") return; // not a tip — excluded
    const txHash = t.tx_hash;
    if (proof.ok) {
      const recipient = proof.proof.recipient.toLowerCase();
      const isSelf =
        (subjectEvm !== "" && recipient === subjectEvm) ||
        recipient === subjectPadded;
      const amount = proof.proof.grossTinybar;
      if (isSelf) selfTips++;
      if (amount > BigInt(WHALE_TINYBAR)) whaleTips++;
      totalTinybar += amount;
      analyzed++;
      evidence.push({
        transaction_id: txHash || `ts:${t.consensus_timestamp}`,
        amount_hbar: tinybarToHbar(amount),
        recipient,
        consensus_timestamp: t.consensus_timestamp,
        hashscan: txHash
          ? `https://hashscan.io/mainnet/transaction/${txHash}`
          : "",
        self_tip: isSelf,
      });
      return;
    }
    // Recipient could not be resolved (mirror outage, decode failure):
    // the wash check did not run for this tip. Record it as unknown and
    // let the verdict logic below refuse a clean verdict. Only tipPage
    // calls reach this branch (fetchTipsFrom filters the rest), so a
    // non-tip can never be counted here even when its proof read fails.
    unresolved++;
    analyzed++;
    totalTinybar += BigInt(t.amount_tinybar);
    evidence.push({
      transaction_id: txHash || `ts:${t.consensus_timestamp}`,
      amount_hbar: tinybarToHbar(BigInt(t.amount_tinybar)),
      recipient: "unknown",
      consensus_timestamp: t.consensus_timestamp,
      hashscan: txHash
        ? `https://hashscan.io/mainnet/transaction/${txHash}`
        : "",
      self_tip: false,
    });
  });

  // Verdict logic (deterministic, documented):
  // - insufficient_data: fewer than MIN_TIPS_FOR_VERDICT tips observed,
  //   OR the wash check did not run (any sampled tip's recipient
  //   unresolved) — a verdict that cannot see the recipient must never
  //   report "clean" and must never be attested on HCS.
  // - flagged: self-tip rate >= 50% (wash pattern) OR any single tip
  //   exceeds 100 HBAR (anomaly worth human review).
  // - clean: otherwise.
  const n = analyzed;
  const washCheckRan = unresolved === 0;
  let verdict: TippingVerdict;
  let confidence: TippingReview["confidence"];
  let summary: string;

  if (n < MIN_TIPS_FOR_VERDICT) {
    verdict = "insufficient_data";
    confidence = "low";
    summary = `only ${n} tip(s) observed for ${accountId} — not enough history for a verdict`;
  } else if (!washCheckRan) {
    verdict = "insufficient_data";
    confidence = "low";
    summary = `wash check did not run — recipient unresolved for ${unresolved} of ${n} tip(s); no clean verdict can be issued`;
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
  // No attestation is ever issued for a verdict the wash check did not
  // back: insufficient_data (too little history, or an unresolved
  // recipient) commits nothing to the public log. A clean bill of health
  // that missed self-tips must never become an HCS attestation.
  const attestable = verdict !== "insufficient_data" && washCheckRan;
  const attestationTx = attestable
    ? await buildAttestationTx(attestationTopic, reportHash, subject, verdict)
    : null;

  return {
    ...reportBase,
    report_hash: reportHash,
    attestation_tx_base64: attestationTx,
    attestation_note: !washCheckRan
      ? "no attestation issued — the wash check did not run, so no verdict is committed publicly"
      : verdict === "insufficient_data"
        ? "no attestation issued — not enough verified history for a verdict"
        : attestationTx
          ? "unsigned HCS attestation tx — sign with your key and submit to commit this review publicly; you become the attestor"
          : "attestation topic not yet configured — verdict and evidence above are still fully verifiable via the mirror node",
  };
}
