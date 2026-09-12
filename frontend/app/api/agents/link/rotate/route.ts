import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { getKvStore } from "@/lib/server/store";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { rotateAgentKey } from "@/lib/server/agents/links";

export const runtime = "nodejs";

/**
 * POST /api/agents/link/rotate — issue a fresh API key for an existing
 * link. Body: { agentAccountId }. The old key stops working immediately.
 * The new plaintext key is returned exactly once. Session auth.
 */
export async function POST(req: NextRequest) {
  const cred = sessionCredentialFrom(req);
  if (!cred) {
    return NextResponse.json({ error: "missing session: sign in with your wallet first" }, { status: 401 });
  }
  const verified = await defaultAuthPort().verifySession(cred);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const agentAccountId =
    typeof (body as Record<string, unknown> | null)?.agentAccountId === "string"
      ? ((body as Record<string, unknown>).agentAccountId as string).trim()
      : "";
  if (!/^0\.0\.\d+$/.test(agentAccountId)) {
    return NextResponse.json({ error: "agentAccountId is required (0.0.x)" }, { status: 400 });
  }
  let rotated;
  try {
    rotated = await rotateAgentKey(getKvStore(), verified.session.address, agentAccountId);
  } catch {
    return NextResponse.json({ error: "link service unavailable — try again in a moment" }, { status: 503 });
  }
  if (!rotated.ok) {
    return NextResponse.json({ error: rotated.error }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    agentAccountId,
    apiKey: rotated.apiKey,
    keyId: rotated.link.keyId,
    warning: "Copy the apiKey now — it is shown exactly once and never stored.",
  });
}
