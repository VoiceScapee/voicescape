import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  defaultDeps,
  warnUser,
  type WarnUserBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * POST /api/townhall/moderation/warn {wallet, targetUsername?, reason}
 *
 * Issue a formal warning: logged on HCS, no write restriction. Mod-only.
 * First rung of the escalation ladder.
 * 201 → {seq, wallet}.
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
  const { status, json } = await warnUser(defaultDeps(), withAuth((body ?? {}) as WarnUserBody, req));
  return NextResponse.json(json, { status });
}
