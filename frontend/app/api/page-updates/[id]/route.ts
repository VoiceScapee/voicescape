/**
 * GET /api/page-updates/[id] — public summary of a keyless-agent page-update
 * proposal for the approval link (/p/<id>).
 *
 * The agent drops this link in its OWN chat; the human opens it, reviews
 * what the agent proposed, and taps Approve — no Buddy chat, no dapp
 * sign-in needed. Public by design (unguessable id); it carries only what
 * the human needs to decide, never keys or token values.
 */
import { NextResponse } from "next/server";
import { getPendingActionByPublicId } from "@/lib/server/pending-actions";
import { ipGate } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gated = await ipGate(req, "page-update-summary", "PAGE_UPDATE_SUMMARY_IP_LIMIT", 60, "too many requests — try again in a bit");
  if (gated) return gated;

  const { id } = await params;
  const action = await getPendingActionByPublicId(id);
  if (!action || action.kind !== "agent-page-update" || !action.pageUpdate) {
    return NextResponse.json(
      { error: "this approval link is invalid or expired — ask your agent for a fresh proposal" },
      { status: 404 },
    );
  }
  const spec = action.pageUpdate.spec;
  return NextResponse.json({
    proposal_id: action.id,
    username: spec.username,
    change_summary: action.pageUpdate.changeSummary,
    display_name: spec.displayName ?? spec.username,
    purpose: spec.purpose ?? "",
    owner_account_id: action.ownerAccountId,
    cost_estimate: action.costEstimate,
    created_at: new Date(action.createdAt).toISOString(),
    expires_at: new Date(action.createdAt + 24 * 3_600_000).toISOString(),
  });
}
