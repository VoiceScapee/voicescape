import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  createProposal,
  defaultDeps,
  getProposals,
  type CreateProposalBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/** GET /api/townhall/proposals → {proposals:[{id,author,title,body,closesAt,yes,no,abstain}]} */
export async function GET() {
  const { status, json } = await getProposals(defaultDeps());
  return NextResponse.json(json, { status });
}

/**
 * POST /api/townhall/proposals {author,title,body,closesAt,dustFeeTxId}
 * Dust fee required. 201 → {id}.
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
  const { status, json } = await createProposal(defaultDeps(), withAuth((body ?? {}) as CreateProposalBody, req));
  return NextResponse.json(json, { status });
}
