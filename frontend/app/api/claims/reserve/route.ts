/**
 * POST /api/claims/reserve — soft-reserve a blockpage handle for a
 * claimant secp256k1 key (reservable claims, converged spec v2).
 *
 * Body: { username, claimant_pubkey, nonce, claim_code?, renew? }
 *
 * Atomic claim-or-reject: single-command SET … NX PX — exactly one winner
 * per handle, one active reservation per claimant key. The reservation is
 * a SOFT HOLD, not a lock: a direct on-chain registerPage still wins.
 *
 * Rate-limited per IP (20/hr, same tier as MCP write tools). Never holds
 * keys, never signs, never spends.
 */
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { reserveHandle, getReservation } from "@/lib/server/claim-reservations";
import { ipGate } from "@/lib/server/rate-limit";

/**
 * GET /api/claims/reserve?username=<name> — reservation status read.
 *
 * Read-only: returns the reservation state pre-funding so an agent (or its
 * operator) can check whether a handle is reserved before funding —
 * closes the "no claim_package_id pre-funding" gap from the cold-walk.
 * No auth; IP rate-limited like other directory reads. Never reveals the
 * claimant's key — only the funding address (public by design: it's the
 * hollow alias anyone can derive) and the hold state.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const gated = await ipGate(
    req,
    "claims-reserve-status",
    "IP_RATE_LIMIT_CLAIMS_RESERVE_STATUS",
    60,
    "too many status checks from this network — try again in a bit",
  );
  if (gated) return gated;

  const username = (req.nextUrl.searchParams.get("username") ?? "").trim().toLowerCase();
  if (!username) {
    return NextResponse.json({ error: "username query parameter required" }, { status: 400 });
  }

  let rec: Awaited<ReturnType<typeof getReservation>>;
  try {
    rec = await getReservation(username);
  } catch {
    return NextResponse.json(
      { error: "reservation store temporarily unavailable — try again in a moment" },
      { status: 503 },
    );
  }

  if (!rec) {
    return NextResponse.json({ reserved: false, username });
  }
  return NextResponse.json({
    reserved: true,
    username: rec.username,
    reservation_id: rec.reservation_id,
    reserved_until: new Date(rec.expires_at).toISOString(),
    renewals_used: rec.renewals_used,
    funding_address: rec.funding_address,
    soft_hold: true,
    note: "reserved (soft, unverified) — a direct on-chain registerPage still wins",
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gated = await ipGate(
    req,
    "claims-reserve",
    "IP_RATE_LIMIT_CLAIMS_RESERVE",
    20,
    "too many reservation requests from this network — try again later",
  );
  if (gated) return gated;

  let body: {
    username?: unknown;
    claimant_pubkey?: unknown;
    nonce?: unknown;
    claim_code?: unknown;
    renew?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  let outcome: Awaited<ReturnType<typeof reserveHandle>>;
  try {
    outcome = await reserveHandle({
      username: typeof body.username === "string" ? body.username : "",
      claimant_pubkey: typeof body.claimant_pubkey === "string" ? body.claimant_pubkey : "",
      nonce: typeof body.nonce === "string" ? body.nonce : "",
      claim_code: typeof body.claim_code === "string" ? body.claim_code : null,
      renew: body.renew === true,
    });
  } catch {
    // Store unreachable — fail closed.
    return NextResponse.json(
      { error: "reservation store temporarily unavailable — try again in a moment" },
      { status: 503 },
    );
  }

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: 409 });
  }
  const r = outcome.reservation;
  return NextResponse.json({
    reserved: true,
    existing: outcome.existing,
    renewed: outcome.renewed,
    reservation_id: r.reservation_id,
    username: r.username,
    reserved_until: new Date(r.expires_at).toISOString(),
    funding_address: r.funding_address,
    renewals_used: r.renewals_used,
    nonce: r.nonce,
    soft_hold: true,
    note: "soft hold, not a lock — a direct on-chain registerPage still wins",
  });
}
