import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  castRepVote,
  defaultDeps,
  getReputation,
  type CastRepVoteBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/** GET /api/townhall/reputation?target=&voter= → {target,up,down,score,myVote} */
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const { status, json } = await getReputation(
    defaultDeps(),
    sp.get("target") ?? undefined,
    sp.get("voter") ?? undefined,
  );
  return NextResponse.json(json, { status });
}

/**
 * POST /api/townhall/reputation {target,voter,value}
 * One vote per voter per target (changeable). 400 on self-vote.
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
  const { status, json } = await castRepVote(defaultDeps(), withAuth((body ?? {}) as CastRepVoteBody, req));
  return NextResponse.json(json, { status });
}
