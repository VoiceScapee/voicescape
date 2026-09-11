import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  defaultDeps,
  queryAppeals,
  submitAppeal,
  type QueryAppealsBody,
  type SubmitAppealBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * POST /api/townhall/appeals {reason}
 *
 * Appeal a timeout or ban. Filed by the restricted wallet itself — no
 * page ownership, no dust fee, no restriction check (a restricted user
 * must always be able to be heard). One pending appeal per wallet.
 * 201 → {seq}. Errors: 400 no active restriction / bad input, 401 no
 * session, 409 appeal already pending.
 */
export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "townhall",
    "IP_RATE_LIMIT_TOWNHALL",
    300,
    "too many town hall writes from this network — try again later",
  );
  if (gated) return gated;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { status, json } = await submitAppeal(defaultDeps(), withAuth((body ?? {}) as SubmitAppealBody, req));
  return NextResponse.json(json, { status });
}

/**
 * GET /api/townhall/appeals
 *
 * Pending appeal queue, newest first, with each appellant's live
 * restriction state. Mod-only. Session from the x-vs-session header.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const { status, json } = await queryAppeals(
    defaultDeps(),
    withAuth({ username: q.get("username") ?? undefined } as QueryAppealsBody, req),
  );
  return NextResponse.json(json, { status });
}
