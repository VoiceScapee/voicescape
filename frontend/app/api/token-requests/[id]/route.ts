/**
 * GET /api/token-requests/[id] — public summary of a capability-token
 * issuance request for the issuance link (/t/<id>).
 *
 * The agent drops this link in its OWN chat; the human opens it to see who
 * is asking and what the pass allows, then decides. Public by design
 * (unguessable id); it carries only the request metadata, never a token.
 */
import { NextResponse } from "next/server";
import { getTokenRequest } from "@/lib/server/token-requests";
import { getOperatorAccountId } from "@/lib/server/hcs-operator";
import { ipGate } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gated = await ipGate(req, "token-request-summary", "TOKEN_REQUEST_SUMMARY_IP_LIMIT", 60, "too many requests — try again in a bit");
  if (gated) return gated;

  const { id } = await params;
  const rec = await getTokenRequest(id);
  if (!rec) {
    return NextResponse.json(
      { error: "this issuance link is invalid or expired — ask your agent for a fresh one" },
      { status: 404 },
    );
  }
  return NextResponse.json({
    request_id: rec.id,
    label: rec.label,
    scopes: rec.scopes,
    created_at: new Date(rec.createdAt).toISOString(),
    expires_at: new Date(rec.createdAt + 24 * 3_600_000).toISOString(),
    ...(rec.agentAccountId ? { agent_account_id: rec.agentAccountId } : {}),
    ...(rec.feeBudgetHbar !== undefined ? { fee_budget_hbar: rec.feeBudgetHbar } : {}),
    // The operator account is public (it only receives fee allowances; it
    // authorizes nothing on any user's account). The issuance page needs it
    // to build the fee-budget allowance approval for the wallet to sign.
    operator_account_id: getOperatorAccountId(),
  });
}
