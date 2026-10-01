import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultWebhookDeps, deleteSubscription } from "@/lib/server/webhooks";

export const runtime = "nodejs";

/**
 * DELETE /api/webhooks/subscriptions/:id — remove one of the caller's own
 * subscriptions. Unknown ids and other owners' ids both answer 404 (no
 * oracle for subscription existence).
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gated = await ipGate(
    req,
    "webhooks-sub",
    "IP_RATE_LIMIT_WEBHOOKS_SUB",
    20,
    "too many webhook subscription requests — slow down",
  );
  if (gated) return gated;

  const cred = sessionCredentialFrom(req);
  if (!cred) {
    return NextResponse.json({ error: "missing session: sign in with your wallet" }, { status: 401 });
  }
  const deps = defaultWebhookDeps();
  const verified = await deps.verifySession(cred);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }

  const { id } = await params;
  const result = await deleteSubscription(deps, verified.session.address.toLowerCase(), id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}
