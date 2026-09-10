import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  defaultDeps,
  timeoutUser,
  type TimeoutUserBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * POST /api/townhall/moderation/timeout {wallet, targetUsername?, reason, durationMinutes}
 *
 * Time a wallet out: no town-hall writes until the timeout expires
 * (auto-expires; 1–43200 minutes). Mod-only.
 * 201 → {seq, wallet, expiresAt}.
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
  const { status, json } = await timeoutUser(defaultDeps(), withAuth((body ?? {}) as TimeoutUserBody, req));
  return NextResponse.json(json, { status });
}
