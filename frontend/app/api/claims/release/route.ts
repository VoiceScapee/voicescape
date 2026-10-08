/**
 * POST /api/claims/release — claimant-signed early release of a handle
 * reservation (reservable claims, converged spec v2).
 *
 * Body: { username, signature }
 *
 * The signature must be 128-hex (64-byte raw ECDSA r||s) over the UTF-8
 * bytes of `voicescape:release-reservation:v1:<username>:<reservation_id>`,
 * made by the secp256k1 key the reservation is bound to. Same-day
 * availability on operator decline; release+revoke on compromise. Writes
 * a released-by-claimant tombstone. No cooldown — the handle is
 * immediately reservable again.
 *
 * Rate-limited per IP (20/hr). Never holds keys, never spends.
 */
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { releaseReservation } from "@/lib/server/claim-reservations";
import { ipGate } from "@/lib/server/rate-limit";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gated = await ipGate(
    req,
    "claims-release",
    "IP_RATE_LIMIT_CLAIMS_RELEASE",
    20,
    "too many release requests from this network — try again later",
  );
  if (gated) return gated;

  let body: { username?: unknown; signature?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.username !== "string" || typeof body.signature !== "string") {
    return NextResponse.json(
      { error: "username and signature are required" },
      { status: 400 },
    );
  }

  let outcome: Awaited<ReturnType<typeof releaseReservation>>;
  try {
    outcome = await releaseReservation(body.username, body.signature);
  } catch {
    return NextResponse.json(
      { error: "reservation store temporarily unavailable — try again in a moment" },
      { status: 503 },
    );
  }
  if ("error" in outcome) {
    return NextResponse.json({ error: outcome.error }, { status: 400 });
  }
  return NextResponse.json({
    released: true,
    username: outcome.username,
    note: "handle is immediately reservable again — no cooldown",
  });
}
