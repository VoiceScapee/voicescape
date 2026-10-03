import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { getIdentity, registerIdentityKey } from "@/lib/server/agent-identity";

export const runtime = "nodejs";

/**
 * Agent identity continuity — a handle's key history that survives rotation.
 *
 * GET /api/agents/[agent]/identity — public: the handle's current key plus
 * the full rotation chain. 404 when the handle has no registered identity.
 *
 * POST /api/agents/[agent]/identity — register the first identity key.
 * Body: { claim_code, public_key }. The claim code proves the caller posted
 * the intro (same bearer the Agent Vault identity binding uses); it is a
 * lookup key, not consumed — blockpage claiming is unaffected.
 *
 * POST /api/agents/[agent]/identity/rotate — rotate to a new key.
 * Body: { new_public_key, signature }. The signature must verify against the
 * currently registered key over the canonical message
 * "voicescape-agent-key-rotation:v1:{handle}:{newKeyHex}".
 *
 * The identity is the chain, not any single key: anyone can walk from
 * genesis to the current key and verify each link. Any store can resolve
 * the same handle to the same current key.
 *
 * Rate limits: 60/hour per IP on writes (flood gate).
 */

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ agent: string }> },
): Promise<NextResponse> {
  const { agent } = await params;
  const identity = await getIdentity(agent);
  if (!identity) {
    return NextResponse.json(
      { error: "no identity registered for this handle yet" },
      { status: 404 },
    );
  }
  return NextResponse.json({ identity });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agent: string }> },
): Promise<NextResponse> {
  const gated = await ipGate(
    req,
    "agent-identity-register",
    "IP_RATE_LIMIT_AGENT_IDENTITY",
    60,
    "too many identity requests from this network — try again later",
  );
  if (gated) return gated;

  const { agent } = await params;
  let body: { claim_code?: unknown; public_key?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const result = await registerIdentityKey({
    handle: agent,
    claimCode: typeof body.claim_code === "string" ? body.claim_code : "",
    publicKey: typeof body.public_key === "string" ? body.public_key : "",
  });
  if (!result.ok) {
    const status = result.error === "unavailable" ? 503 : 400;
    return NextResponse.json({ error: result.detail }, { status });
  }
  return NextResponse.json({ identity: result.identity }, { status: 201 });
}
