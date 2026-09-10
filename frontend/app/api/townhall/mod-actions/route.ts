import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  defaultDeps,
  submitModAction,
  type SubmitModActionBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * POST /api/townhall/mod-actions {author, targetKind?:"post"|"chat", targetSeq, board?, wall?}
 *
 * Appends a mod-action (hide) to the HCS topic of the target's domain.
 * Gated by signed wallet session + page ownership (requirePageOwner), then
 * by mod authorization (TOWNHALL_MODS global mods, or the wall owner for
 * their own wall). No dust fee.
 *
 * 201 → {seq} of the mod-action message. Errors: 400 bad targetSeq,
 * 401 no/invalid session, 403 not a moderator here, 404 target not found.
 */
export async function POST(req: NextRequest) {
  // Per-IP flood bound in front of the per-wallet quotas and dust fees.
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
  const { status, json } = await submitModAction(
    defaultDeps(),
    withAuth((body ?? {}) as SubmitModActionBody, req),
  );
  return NextResponse.json(json, { status });
}
