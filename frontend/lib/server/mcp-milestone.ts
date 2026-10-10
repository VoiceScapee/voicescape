/**
 * Milestone-commit tools — the open-source Hedera fix for "who bears the
 * buyer-vanishes risk" (no-escrow hire flow).
 *
 * Honest mechanics (verified 2026-10-10 against Hedera docs, the
 * hedera-services scheduled-transaction spec, @hiero-ledger/sdk source,
 * and the live mainnet mirror node):
 *
 * - A ScheduleCreate has NO "additional required signer" field. Execution
 *   gates strictly on the inner transaction's own keys. There is NO
 *   "worker signs to release" with these primitives — that design was
 *   researched and killed before a line of code was written.
 * - What IS real (veto402-style): the buyer creates + signs a scheduled
 *   tipPage payment with waitForExpiry=true and expiry = milestone
 *   deadline. The commitment is on-chain and publicly verifiable before
 *   work starts; it auto-executes at the deadline (the buyer cannot vanish
 *   silently); the buyer CAN delete it via their admin key, but deletion
 *   is itself an on-chain-visible transaction.
 * - This is a commitment device, not a lock. Payment lands at the
 *   deadline, not at completion. Both sides see the same on-chain truth.
 *
 * Server never holds keys. prepare_milestone_commit returns UNSIGNED bytes
 * for the buyer's own wallet to sign (HashPack/Blade via wallet-connect
 * sign ScheduleCreate today). verify_milestone_commit is read-only against
 * the public mirror node.
 */
import {
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  Hbar,
  PublicKey,
  ScheduleCreateTransaction,
  Timestamp,
  Transaction,
  TransactionId,
} from "@hiero-ledger/sdk";
import { lookupBlockpage, MIRROR_BASE } from "./mcp-tools";
import { tinybarToHbar } from "../tx-proof";

/** Tips contract — the settlement rail (atomic 98/2). */
const TIPS_CONTRACT_ID = "0.0.10854060";
/** Generous gas for a payable tipPage call (registry calls use 600k). */
const TIPPAGE_GAS = 500_000;
/** Max schedule lifetime on mainnet (HIP-423): 62 days. We cap at 61. */
const MAX_EXPIRY_DAYS = 61;
/** Schedule memo cap: 100 bytes. */
const MAX_MEMO_BYTES = 100;

type FetchFn = typeof fetch;

async function fetchJson(
  fetchFn: FetchFn,
  url: string,
): Promise<{ ok: boolean; status: number; body: any }> {
  try {
    const res = await fetchFn(url, { cache: "no-store" } as RequestInit);
    if (!res.ok) return { ok: false, status: res.status, body: null };
    return { ok: true, status: res.status, body: await res.json() };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
const ACCOUNT_RE = /^0\.0\.\d+$/;

function parseHbarToTinybar(s: string): bigint | null {
  const t = s.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  try {
    return BigInt(w) * 100_000_000n + BigInt((f + "00000000").slice(0, 8));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* prepare_milestone_commit                                            */
/* ------------------------------------------------------------------ */

export interface PrepareMilestoneCommitArgs {
  /** Worker receiving the milestone (tipPage recipient). */
  worker_username: string;
  /** Milestone amount in HBAR, e.g. "5". */
  amount_hbar: string;
  /** Short id for the schedule memo (≤100 bytes), e.g. "homepage-v2-m1". */
  milestone_id: string;
  /** Deadline ISO 8601 — the schedule auto-executes at this time. */
  deadline_iso: string;
  /** Buyer's Hedera account (pays schedule + execution fees). */
  buyer_account_id: string;
  /** Buyer's public key (becomes the schedule admin key, so the buyer can delete). */
  buyer_public_key: string;
}

export interface MilestoneCommitPrepared {
  ok: true;
  /** Base64 unsigned ScheduleCreate bytes — sign in the buyer's own wallet. */
  unsigned_schedule_bytes: string;
  worker_username: string;
  amount_hbar: string;
  creator_net_hbar: string;
  treasury_fee_hbar: string;
  milestone_id: string;
  deadline_iso: string;
  buyer_account_id: string;
  /** Plain-language explanation of what signing commits to. */
  what_signing_means: string;
  warnings: string[];
}

export async function prepareMilestoneCommit(
  args: PrepareMilestoneCommitArgs,
  fetchFn: FetchFn = fetch,
): Promise<MilestoneCommitPrepared | { error: string }> {
  const username = (args.worker_username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return { error: `worker_username "${args.worker_username}" is not a valid blockpage name` };
  }
  const tinybar = parseHbarToTinybar(args.amount_hbar ?? "");
  if (tinybar === null || tinybar <= 0n) {
    return { error: `amount_hbar "${args.amount_hbar}" is not a positive HBAR amount` };
  }
  const milestoneId = (args.milestone_id ?? "").trim();
  if (!milestoneId || Buffer.byteLength(milestoneId, "utf8") > MAX_MEMO_BYTES) {
    return { error: "milestone_id is required and must fit in 100 bytes" };
  }
  const deadline = new Date(args.deadline_iso ?? "");
  if (isNaN(deadline.getTime())) {
    return { error: `deadline_iso "${args.deadline_iso}" is not a valid ISO 8601 timestamp` };
  }
  const now = Date.now();
  if (deadline.getTime() <= now) {
    return { error: "deadline_iso must be in the future" };
  }
  if (deadline.getTime() - now > MAX_EXPIRY_DAYS * 24 * 3600 * 1000) {
    return { error: `deadline_iso is more than ${MAX_EXPIRY_DAYS} days out — Hedera caps schedule expiry at 62 days` };
  }
  const buyerAccount = (args.buyer_account_id ?? "").trim();
  if (!ACCOUNT_RE.test(buyerAccount)) {
    return { error: `buyer_account_id "${args.buyer_account_id}" is not a 0.0.x account id` };
  }
  let buyerKey: PublicKey;
  try {
    buyerKey = PublicKey.fromString((args.buyer_public_key ?? "").trim());
  } catch {
    return { error: "buyer_public_key is not a parseable Hedera public key (ED25519 or ECDSA)" };
  }

  // The worker must exist — never commit funds to an unregistered name.
  let lookup;
  try {
    lookup = await lookupBlockpage(username, fetchFn);
  } catch {
    return { error: "registry unavailable — try again in a moment" };
  }
  if (!lookup.found) {
    return { error: `blockpage "@${username}" is not registered on-chain — no commitment prepared` };
  }

  const warnings: string[] = [];
  let bytesB64: string;
  try {
    // Inner: the milestone payment itself — tipPage settles atomic 98/2.
    const inner = new ContractExecuteTransaction()
      .setContractId(TIPS_CONTRACT_ID)
      .setFunction("tipPage", new ContractFunctionParameters().addString(username))
      .setPayableAmount(Hbar.fromTinybars(tinybar.toString()))
      .setGas(TIPPAGE_GAS);

    // Outer: the commitment. waitForExpiry=true so the buyer's signature at
    // creation does NOT execute immediately — the network holds the signed
    // intent until the deadline. adminKey = buyer, so only the buyer can
    // delete (and deletion is on-chain visible).
    const schedule = new ScheduleCreateTransaction()
      .setScheduledTransaction(inner)
      .setScheduleMemo(milestoneId)
      .setAdminKey(buyerKey)
      .setExpirationTime(Timestamp.fromDate(deadline))
      .setWaitForExpiry(true)
      .setTransactionId(TransactionId.generate(buyerAccount));

    const client = Client.forMainnet();
    try {
      schedule.freezeWith(client);
    } finally {
      client.close();
    }
    bytesB64 = Buffer.from(schedule.toBytes()).toString("base64");
  } catch (e) {
    return { error: `could not build the schedule: ${(e as Error).message}` };
  }

  const treasury = (tinybar * 2n) / 100n;
  return {
    ok: true,
    unsigned_schedule_bytes: bytesB64,
    worker_username: username,
    amount_hbar: tinybarToHbar(tinybar),
    creator_net_hbar: tinybarToHbar(tinybar - treasury),
    treasury_fee_hbar: tinybarToHbar(treasury),
    milestone_id: milestoneId,
    deadline_iso: deadline.toISOString(),
    buyer_account_id: buyerAccount,
    what_signing_means:
      `Signing creates an on-chain scheduled payment of ${tinybarToHbar(tinybar)} HBAR to @${username} ` +
      `(they net ${tinybarToHbar(tinybar - treasury)} after the 2% treasury fee, settled atomically by the Tips contract). ` +
      `It does NOT move funds now — the network holds your signed intent and executes it automatically at ${deadline.toISOString()}. ` +
      `You can cancel any time before then by deleting the schedule with this same key; the cancellation is visible on-chain, so the worker will see it. ` +
      `After the deadline the payment is irreversible.`,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* verify_milestone_commit                                             */
/* ------------------------------------------------------------------ */

export interface VerifyMilestoneCommitArgs {
  /** Schedule id, e.g. "0.0.10912653". */
  schedule_id: string;
  /** Optional: the milestone id you expect in the schedule memo. */
  expected_milestone_id?: string;
  /** Optional: the worker username you expect as tipPage recipient. */
  expected_worker_username?: string;
  /** Optional: the HBAR amount you expect, e.g. "5". */
  expected_amount_hbar?: string;
}

export type MilestoneStatus =
  | "committed"
  | "awaiting_buyer_signature"
  | "executed"
  | "deleted"
  | "expired";

export interface MilestoneCommitVerification {
  ok: boolean;
  error?: string;
  schedule_id?: string;
  status?: MilestoneStatus;
  /** Safe for the worker to start work? */
  safe_to_start?: boolean;
  reasons?: string[];
  memo?: string | null;
  wait_for_expiry?: boolean;
  expiration_iso?: string | null;
  executed_iso?: string | null;
  deleted?: boolean;
  inner_contract?: string | null;
  inner_function?: string | null;
  inner_recipient_username?: string | null;
  inner_amount_hbar?: string | null;
  signer_count?: number;
}

export async function verifyMilestoneCommit(
  args: VerifyMilestoneCommitArgs,
  fetchFn: FetchFn = fetch,
): Promise<MilestoneCommitVerification> {
  const scheduleId = (args.schedule_id ?? "").trim();
  if (!ACCOUNT_RE.test(scheduleId)) {
    return { ok: false, error: `schedule_id "${args.schedule_id}" is not a 0.0.x id` };
  }

  const { ok, status, body } = await fetchJson(fetchFn, `${MIRROR_BASE}/schedules/${scheduleId}`);
  if (!ok) {
    return {
      ok: false,
      error: status === 404 ? `schedule ${scheduleId} not found on Hedera mainnet` : "mirror node unavailable — try again in a moment",
    };
  }

  const reasons: string[] = [];
  const out: MilestoneCommitVerification = {
    ok: true,
    schedule_id: scheduleId,
    reasons,
    memo: typeof body?.memo === "string" ? body.memo : null,
    wait_for_expiry: body?.wait_for_expiry === true,
    expiration_iso: isoFromMirrorTs(body?.expiration_time),
    executed_iso: isoFromMirrorTs(body?.executed_timestamp),
    deleted: body?.deleted === true,
    signer_count: Array.isArray(body?.signatures) ? body.signatures.length : 0,
  };

  // Decode the inner transaction, if present.
  if (typeof body?.transaction_body === "string" && body.transaction_body) {
    try {
      const inner = Transaction.fromBytes(Buffer.from(body.transaction_body, "base64"));
      if (inner instanceof ContractExecuteTransaction) {
        const contractId = inner.contractId?.toString() ?? null;
        out.inner_contract = contractId;
        try {
          const params = inner.functionParameters;
          // tipPage(string username): first 4 bytes selector, then ABI string.
          const decoded = decodeTipPageParams(params);
          out.inner_function = decoded ? "tipPage" : null;
          out.inner_recipient_username = decoded;
        } catch {
          out.inner_function = null;
        }
        const payable = (inner as unknown as { payableAmount?: unknown }).payableAmount;
        // toTinybars() returns a BigNumber — stringify before BigInt.
        const tinybars =
          payable && typeof (payable as { toTinybars?: unknown }).toTinybars === "function"
            ? (payable as { toTinybars(): { toString(): string } }).toTinybars().toString()
            : null;
        out.inner_amount_hbar = tinybars !== null ? tinybarToHbar(BigInt(tinybars)) : null;
      }
    } catch {
      reasons.push("could not decode the scheduled inner transaction — treating schedule state only");
    }
  }

  // Status determination.
  if (out.deleted) {
    out.status = "deleted";
    out.safe_to_start = false;
    reasons.push("the buyer deleted this schedule on-chain — the commitment is cancelled. Do not start work.");
    return out;
  }
  if (out.executed_iso) {
    out.status = "executed";
    out.safe_to_start = false;
    reasons.push("the scheduled payment already executed — settled. Verify the payment with verify_tip.");
    return out;
  }
  const expMs = mirrorTsToMs(body?.expiration_time);
  if (expMs !== null && expMs <= Date.now()) {
    out.status = "expired";
    out.safe_to_start = false;
    reasons.push("the schedule expired without executing — do not start work.");
    return out;
  }
  if ((out.signer_count ?? 0) === 0) {
    out.status = "awaiting_buyer_signature";
    out.safe_to_start = false;
    reasons.push("no signatures on the schedule yet — the buyer has not committed. Do not start work.");
    return out;
  }

  // Signed and live — check the expected terms, when the worker supplied them.
  let termsOk = true;
  const expMemo = (args.expected_milestone_id ?? "").trim();
  if (expMemo && out.memo !== expMemo) {
    termsOk = false;
    reasons.push(`memo mismatch: schedule says "${out.memo}", expected "${expMemo}".`);
  }
  const expUser = (args.expected_worker_username ?? "").trim().toLowerCase();
  if (expUser && out.inner_recipient_username !== expUser) {
    termsOk = false;
    reasons.push(
      `recipient mismatch: schedule pays "${out.inner_recipient_username ?? "unknown"}", expected "${expUser}".`,
    );
  }
  const expAmt = (args.expected_amount_hbar ?? "").trim();
  if (expAmt) {
    const expTiny = parseHbarToTinybar(expAmt);
    const gotTiny = out.inner_amount_hbar ? parseHbarToTinybar(out.inner_amount_hbar) : null;
    if (expTiny === null || gotTiny === null || expTiny !== gotTiny) {
      termsOk = false;
      reasons.push(`amount mismatch: schedule carries ${out.inner_amount_hbar ?? "unknown"} HBAR, expected ${expAmt}.`);
    }
  }
  if (out.inner_contract && out.inner_contract !== TIPS_CONTRACT_ID) {
    termsOk = false;
    reasons.push(`contract mismatch: schedule targets ${out.inner_contract}, expected the Tips contract ${TIPS_CONTRACT_ID}.`);
  }
  if (out.wait_for_expiry !== true) {
    termsOk = false;
    reasons.push("schedule does not use wait_for_expiry — it may execute before the deadline. Do not rely on it as a commitment.");
  }

  out.status = "committed";
  out.safe_to_start = termsOk;
  if (termsOk) {
    reasons.push(
      `buyer's signed commitment verified on-chain: ${out.inner_amount_hbar} HBAR to @${out.inner_recipient_username}, ` +
        `auto-executes at ${out.expiration_iso}. Safe to start work.`,
    );
  } else {
    reasons.unshift("commitment exists but its terms do not match what was agreed — do not start work.");
  }
  return out;
}

function mirrorTsToMs(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const [s, n = "0"] = ts.split(".");
  const ms = Number(s) * 1000 + Math.floor(Number("0." + n) * 1000);
  return Number.isFinite(ms) ? ms : null;
}

function isoFromMirrorTs(ts: unknown): string | null {
  const ms = mirrorTsToMs(ts);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Decode tipPage(string) params: 4-byte selector + ABI-encoded string.
 * Returns the username, or null when the params are not tipPage-shaped.
 */
function decodeTipPageParams(params: Uint8Array | null | undefined): string | null {
  if (!params || params.length < 4 + 64) return null;
  try {
    const view = Buffer.from(params);
    // ABI string: offset (32 bytes) then length (32 bytes) then data.
    const len = Number(BigInt("0x" + view.subarray(4 + 32, 4 + 64).toString("hex")));
    if (len <= 0 || len > 32 || 4 + 64 + len > view.length) return null;
    return view.subarray(4 + 64, 4 + 64 + len).toString("utf8");
  } catch {
    return null;
  }
}
