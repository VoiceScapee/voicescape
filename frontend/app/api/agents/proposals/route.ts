import { NextRequest, NextResponse } from "next/server";
import { agentOwnerFromRequest } from "@/lib/server/agent-session";
import { getPendingAction, clearPendingAction } from "@/lib/server/pending-actions";

export const runtime = "nodejs";

/**
 * /api/agents/proposals — the owner's pending-approval inbox.
 * Session-authenticated (x-vs-session); strictly per-owner.
 *
 * GET  → { proposals: PendingAction[] } (one slot per owner, so 0 or 1).
 *        The chat polls this every ~15s and renders each proposal as an
 *        inline one-tap approval card in the thread.
 * POST { action: "dismiss" } → clears the slot. The chat calls this when a
 *        proposal settles (approved or errored) so it doesn't reappear.
 */
export async function GET(req: NextRequest) {
  const owner = await agentOwnerFromRequest(req);
  if (!owner) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  const pending = await getPendingAction(owner);
  return NextResponse.json({ proposals: pending ? [pending] : [] });
}

export async function POST(req: NextRequest) {
  const owner = await agentOwnerFromRequest(req);
  if (!owner) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (!body || body.action !== "dismiss") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  await clearPendingAction(owner);
  return NextResponse.json({ ok: true });
}
