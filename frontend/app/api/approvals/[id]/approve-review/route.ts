/**
 * POST /api/approvals/[id]/approve-review — human taps Approve on a
 * hire-review approval link (/p/<id>), posting the review.
 *
 * Body: { account_id: "0.0.x" } — the wallet the human just paired on the
 * approval page. Auth: none beyond the unguessable approval id — the
 * paired account MUST equal the approval's owner (the human who issued
 * the agent's capability token); anything else is rejected.
 *
 * At approve time (and only then) the proof-of-payment tx is CLAIMED —
 * an untapped request never burns the proof — then the review is written
 * and the pending action cleared. If the proof was already claimed
 * (double-approval race or a direct post_hire_review in between), the
 * human gets the honest error, nothing is written, and the approval is
 * left in place. Rate-limited per IP. Never touches keys; never signs.
 */
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import {
  getPendingActionByPublicId,
  clearPendingAction,
} from "@/lib/server/pending-actions";
import {
  claimReviewTx,
  releaseReviewTx,
  addReview,
  getReviewSummary,
  type VerifiedReview,
} from "@/lib/server/agents/reviews";
import { ipGate } from "@/lib/server/rate-limit";

const PROPOSAL_MAX_AGE_MS = 24 * 3_600_000;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await ipGate(
    req,
    "approval-approve-review",
    "APPROVAL_APPROVE_REVIEW_IP_LIMIT",
    20,
    "too many approval attempts — try again in a bit",
  );
  if (gated) return gated;

  let accountId = "";
  try {
    const body = (await req.json()) as { account_id?: unknown };
    accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
  } catch {
    return NextResponse.json({ error: "body must be JSON with account_id" }, { status: 400 });
  }
  if (!/^\d+\.\d+\.\d+$/.test(accountId)) {
    return NextResponse.json({ error: "account_id must be a 0.0.x Hedera account" }, { status: 400 });
  }

  const { id } = await params;
  const action = await getPendingActionByPublicId(id);
  if (!action || action.kind !== "hire-review" || !action.hireReview) {
    return NextResponse.json(
      { error: "approval not found or expired — ask your agent for a fresh request" },
      { status: 404 },
    );
  }
  if (Date.now() - action.createdAt >= PROPOSAL_MAX_AGE_MS) {
    return NextResponse.json(
      { error: "approval expired — ask your agent to request it again" },
      { status: 410 },
    );
  }

  // The paired wallet MUST be the approval's owner (the human who issued
  // the agent's capability token). This is the authorization.
  if (accountId !== action.ownerAccountId) {
    return NextResponse.json(
      { error: "this approval belongs to a different wallet — connect the wallet your agent serves" },
      { status: 403 },
    );
  }

  const r = action.hireReview;

  // Claim the proof tx NOW — the human approved, so the proof is spent.
  let claimed: boolean;
  try {
    claimed = await claimReviewTx(r.proofTxId);
  } catch {
    return NextResponse.json({ error: "could not record the review — try again in a moment" }, { status: 500 });
  }
  if (!claimed) {
    return NextResponse.json(
      { error: "this payment already backs a review — nothing was posted" },
      { status: 409 },
    );
  }

  const review: VerifiedReview = {
    txId: r.proofTxId,
    kind: r.proofKind,
    reviewer: r.reviewerEvm,
    reviewerUsername: r.reviewerUsername,
    rating: r.rating,
    text: r.text,
    timestamp: new Date().toISOString(),
  };
  try {
    await addReview(r.targetUsername, review);
  } catch {
    // Release the claim so the proof isn't burned with no recourse.
    try {
      await releaseReviewTx(r.proofTxId);
    } catch {
      /* best-effort */
    }
    return NextResponse.json({ error: "could not record the review — try again in a moment" }, { status: 500 });
  }

  await clearPendingAction(action.ownerAccountId, action.id);

  let summary: unknown = null;
  try {
    summary = await getReviewSummary(r.targetUsername);
  } catch {
    summary = null;
  }
  return NextResponse.json({ review, summary });
}
