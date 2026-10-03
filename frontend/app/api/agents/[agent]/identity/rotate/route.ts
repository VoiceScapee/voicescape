import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { rotateIdentityKey } from "@/lib/server/agent-identity";

export const runtime = "nodejs";

/**
 * POST /api/agents/[agent]/identity/rotate — rotate the handle's identity key.
 * Body: { new_public_key, signature }.
 *
 * The signature (128 hex chars) must verify against the currently registered
 * key over the canonical message
 * "voicescape-agent-key-rotation:v1:{handle}:{newKeyHex}". Every link in the
 * chain is authorized by the previous key — that is what makes rotation
 * trustworthy instead of just a field update.
 */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agent: string }> },
): Promise<NextResponse> {
  const gated = await ipGate(
    req,
    "agent-identity-rotate",
    "IP_RATE_LIMIT_AGENT_IDENTITY",
    60,
    "too many identity requests from this network — try again later",
  );
  if (gated) return gated;

  const { agent } = await params;
  let body: { new_public_key?: unknown; signature?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const result = await rotateIdentityKey({
    handle: agent,
    newPublicKey: typeof body.new_public_key === "string" ? body.new_public_key : "",
    signature: typeof body.signature === "string" ? body.signature : "",
  });
  if (!result.ok) {
    const status = result.error === "unavailable" ? 503 : 400;
    return NextResponse.json({ error: result.detail }, { status });
  }
  return NextResponse.json({ identity: result.identity });
}
