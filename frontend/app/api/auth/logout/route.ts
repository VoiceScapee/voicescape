import { NextRequest, NextResponse } from "next/server";
import { bumpSessionVersion, defaultAuthPort } from "@/lib/server/townhall/auth";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/auth/logout — sign out for real.
 *
 * Bumps the wallet's session revocation generation in the shared store,
 * which instantly invalidates every outstanding session token for that
 * wallet on all instances (verification requires the token's generation
 * to match the current one). The client also clears its local copy —
 * this endpoint is what kills the token everywhere else.
 *
 * Requires a currently VALID session in the `x-vs-session` header: only
 * the wallet's owner can sign out the wallet (nobody can log out someone
 * else's address). Scoped agent tokens (v2) are rejected — an agent
 * cannot sign out its owner's wallet.
 */
export async function POST(req: NextRequest) {
  const gated = await ipGate(req, "auth", "IP_RATE_LIMIT_AUTH", 60, "too many requests — try again later");
  if (gated) return gated;
  const cred = sessionCredentialFrom(req);
  if (typeof cred !== "string" || !cred) {
    return NextResponse.json({ ok: false, error: "no session" }, { status: 401 });
  }
  let result;
  try {
    result = await defaultAuthPort().verifySession(cred);
  } catch (e) {
    const message = e instanceof Error ? e.message : "sign-out unavailable";
    console.error(`[auth] logout failed closed: ${message}`);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 401 });
  }
  if (result.session.agent) {
    return NextResponse.json({ ok: false, error: "agent tokens cannot sign out the wallet" }, { status: 403 });
  }
  let generation: number;
  try {
    generation = await bumpSessionVersion(result.session.address);
  } catch (e) {
    const message = e instanceof Error ? e.message : "sign-out unavailable";
    console.error(`[auth] logout bump failed: ${message}`);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, generation });
}
