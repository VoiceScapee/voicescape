import { NextRequest, NextResponse } from "next/server";
import { agentOwnerFromRequest } from "@/lib/server/agent-session";
import { getAgentOverview } from "@/lib/server/agent-overview";

export const runtime = "nodejs";

/**
 * GET /api/agents/overview — the signed-in owner's mission-control snapshot
 * for their AI agent's blockpage: live registration status, profile pin
 * status, recent on-chain tips. Session-authenticated (x-vs-session);
 * strictly per-owner.
 *
 * 200 → AgentOverview. ownsAgentPage=false (with everything else null/empty)
 * when the wallet owns no agent blockpage — the chat then shows no panel.
 * 401 when there is no valid session.
 */
export async function GET(req: NextRequest) {
  const owner = await agentOwnerFromRequest(req);
  if (!owner) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  const overview = await getAgentOverview(owner);
  return NextResponse.json(overview);
}
