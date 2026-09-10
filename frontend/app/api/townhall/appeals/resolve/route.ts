import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  defaultDeps,
  resolveAppeal,
  type ResolveAppealBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * POST /api/townhall/appeals/resolve {wallet, action: "upheld"|"lifted", note?}
 *
 * Resolve a pending appeal. Mod-only. "lifted" clears the timeout/ban
 * immediately; "upheld" keeps it in force.
 * 201 → {seq, wallet, action}.
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
  const { status, json } = await resolveAppeal(defaultDeps(), withAuth((body ?? {}) as ResolveAppealBody, req));
  return NextResponse.json(json, { status });
}
