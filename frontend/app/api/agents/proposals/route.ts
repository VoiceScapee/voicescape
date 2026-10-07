import { NextRequest, NextResponse } from "next/server";
import { agentOwnerFromRequest } from "@/lib/server/agent-session";
import { getPendingActions, clearPendingAction } from "@/lib/server/pending-actions";

export const runtime = "nodejs";

/**
 * /api/agents/proposals — the owner's pending-approval inbox.
 * Session-authenticated (x-vs-session); strictly per-owner.
 *
 * GET  → { proposals: PendingAction[] } (up to 3 per owner, oldest
 *        first). The chat polls this every ~15s and renders each proposal
 *        as an inline one-tap approval card in the thread.
 * POST { action: "dismiss", id? } → clears one proposal (or the whole
 *        inbox when id is omitted). The chat calls this when a proposal
 *        settles (approved or errored) so it doesn't reappear.
 */
export async function GET(req: NextRequest) {
  const owner = await agentOwnerFromRequest(req);
  if (!owner) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  const proposals = await getPendingActions(owner);
  return NextResponse.json({ proposals });
}

export async function POST(req: NextRequest) {
  const owner = await agentOwnerFromRequest(req);
  if (!owner) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as {
    action?: unknown;
    id?: unknown;
  } | null;
  if (!body || body.action !== "dismiss") {
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  const id = typeof body.id === "string" && body.id ? body.id : undefined;
  try {
    await clearPendingAction(owner, id);
  } catch {
    return NextResponse.json(
      { error: "internal error — try again", code: "INTERNAL_ERROR", retryable: true },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
