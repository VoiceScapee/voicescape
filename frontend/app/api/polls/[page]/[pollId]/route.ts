import { NextRequest, NextResponse } from "next/server";
import { clientIpFromHeaders, ipGate } from "@/lib/server/rate-limit";
import { castVote, defaultPollDeps, getPoll } from "@/lib/server/polls/handlers";

export const runtime = "nodejs";

/**
 * GET /api/polls/[page]/[pollId] — public results. Carries `votedOption`
 * when this IP already voted, so the voter sees their choice.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ page: string; pollId: string }> }) {
  const gated = await ipGate(
    req,
    "polls-read",
    "IP_RATE_LIMIT_POLLS_READ",
    300,
    "too many poll reads from this network — try again later",
  );
  if (gated) return gated;
  const { page, pollId } = await params;
  const { status, json } = await getPoll(
    defaultPollDeps(),
    page,
    pollId,
    clientIpFromHeaders(req.headers),
  );
  return NextResponse.json(json, { status });
}

/**
 * POST /api/polls/[page]/[pollId] {optionIndex, options} — free vote.
 * One vote per IP per poll; the first vote defines the ballot.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ page: string; pollId: string }> }) {
  const gated = await ipGate(
    req,
    "polls-vote",
    "IP_RATE_LIMIT_POLLS_VOTE",
    20,
    "too many votes from this network — try again later",
  );
  if (gated) return gated;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { page, pollId } = await params;
  const { status, json } = await castVote(
    defaultPollDeps(),
    page,
    pollId,
    (body ?? {}) as { optionIndex?: unknown; options?: unknown },
    clientIpFromHeaders(req.headers),
  );
  return NextResponse.json(json, { status });
}
