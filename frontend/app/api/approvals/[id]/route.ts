/**
 * GET /api/approvals/[id] — public summary of a pending approval for the
 * approval link (/p/<id>).
 *
 * Serves the "purchase" and "hire-review" kinds created by the
 * request_purchase_approval / request_review_approval MCP tools. The
 * agent-claim and agent-page-update kinds keep their existing dedicated
 * endpoints — this route only answers the two new kinds.
 *
 * The agent drops the /p/<id> link in its OWN chat; the human opens it,
 * reviews what the agent proposed in plain words, and taps Approve — no
 * Buddy chat, no dapp sign-in needed. Public by design (unguessable id);
 * it carries only what the human needs to decide, never keys or token
 * values.
 */
import { NextResponse } from "next/server";
import { getPendingActionByPublicId } from "@/lib/server/pending-actions";
import { toMirrorTxId } from "@/lib/prepared-tx";
import { ipGate } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

const PROPOSAL_TTL_MS = 24 * 3_600_000;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gated = await ipGate(req, "approval-summary", "APPROVAL_SUMMARY_IP_LIMIT", 60, "too many requests — try again in a bit");
  if (gated) return gated;

  const { id } = await params;
  const action = await getPendingActionByPublicId(id);
  if (!action || (action.kind !== "purchase" && action.kind !== "hire-review")) {
    return NextResponse.json(
      { error: "this approval link is invalid or expired — ask your agent for a fresh request" },
      { status: 404 },
    );
  }
  if (Date.now() - action.createdAt >= PROPOSAL_TTL_MS) {
    return NextResponse.json(
      { error: "this approval expired — ask your agent to request it again" },
      { status: 410 },
    );
  }

  const base = {
    approval_id: action.id,
    kind: action.kind,
    title: action.title,
    summary: action.summary,
    cost_estimate: action.costEstimate,
    owner_account_id: action.ownerAccountId,
    created_at: new Date(action.createdAt).toISOString(),
    expires_at: new Date(action.createdAt + PROPOSAL_TTL_MS).toISOString(),
  };

  if (action.kind === "purchase" && action.purchase) {
    const p = action.purchase;
    return NextResponse.json({
      ...base,
      purchase: {
        listing_id: p.listingId,
        title: p.title,
        seller: p.seller,
        seller_evm: p.sellerEvm,
        contract_id: p.contractId,
        price_usd_cents: p.priceUsdCents,
        value_tinybar: p.valueTinybar,
        value_hbar: p.valueHbar,
        split: "98% to the seller, 2% to the platform — enforced atomically by the Tips contract, no escrow",
      },
    });
  }

  if (action.kind === "hire-review" && action.hireReview) {
    const r = action.hireReview;
    return NextResponse.json({
      ...base,
      review: {
        reviewer_username: r.reviewerUsername,
        target_username: r.targetUsername,
        rating: r.rating,
        text: r.text,
        proof_tx_id: r.proofTxId,
        proof_kind: r.proofKind,
        proof_url: `https://hashscan.io/mainnet/transaction/${toMirrorTxId(r.proofTxId)}`,
      },
    });
  }

  return NextResponse.json(
    { error: "this approval link is invalid or expired — ask your agent for a fresh request" },
    { status: 404 },
  );
}
