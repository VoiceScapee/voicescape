import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import {
  defaultDeps,
  voteProposal,
  type VoteProposalBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * POST /api/townhall/proposals/[id]/vote {voter,choice}
 * Latest vote per voter wins. → {yes,no,abstain}.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { status, json } = await voteProposal(defaultDeps(), params.id, withAuth((body ?? {}) as VoteProposalBody, req));
  return NextResponse.json(json, { status });
}
