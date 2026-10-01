import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { defaultRegistryPort } from "@/lib/server/townhall/registry-check";
import { ipGate } from "@/lib/server/rate-limit";
import { checkContent } from "@/lib/server/townhall/content-filter";
import { getTipsAddress } from "@/lib/contracts";
import { mirrorBaseUrl } from "@/lib/server/townhall/topics";
import { canonicalAddress } from "@/lib/session-message";
import { isValidUsername } from "@/lib/identity";
import { resolveUsernameForOwner } from "@/lib/registry-reverse";
import {
  addReview,
  claimReviewTx,
  getReviewSummary,
  listReviews,
  validateReviewInput,
  verifyReviewTx,
  type VerifiedReview,
} from "@/lib/server/agents/reviews";

export const runtime = "nodejs";

type Params = { params: Promise<{ agent: string }> };

function badUsername(agent: string): NextResponse | null {
  const username = agent.trim().toLowerCase();
  if (!isValidUsername(username)) {
    return NextResponse.json({ error: "invalid agent username" }, { status: 400 });
  }
  return null;
}

/**
 * GET /api/agents/[agent]/reviews?limit=
 *
 * Public, newest-first verified reviews for an agent's page. Each review is
 * linked to a settled Tips-contract transaction (see the proof in `txId` —
 * verify it yourself on HashScan). Never fabricated: an agent with no
 * reviews returns an empty list.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { agent } = await params;
  const bad = badUsername(agent);
  if (bad) return bad;
  const username = agent.trim().toLowerCase();

  const gated = await ipGate(
    req,
    "reviews-read",
    "IP_RATE_LIMIT_REVIEWS_READ",
    300,
    "too many requests — try again later",
  );
  if (gated) return gated;

  const sp = new URL(req.url).searchParams;
  const limit = Number.parseInt(sp.get("limit") ?? "20", 10);
  let list;
  try {
    list = await listReviews(username, Number.isFinite(limit) ? limit : 20);
  } catch {
    return NextResponse.json({ error: "reviews temporarily unavailable" }, { status: 503 });
  }
  return NextResponse.json(list);
}

/**
 * POST /api/agents/[agent]/reviews { txId, rating, text }
 *
 * Leaves a proof-of-payment review. The transaction must be a SUCCESSFUL
 * Tips-contract call whose TipSent/PurchaseCompleted event proves the
 * reviewer's wallet paid THIS agent's page owner. One review per
 * transaction; no self-reviews. Auth: x-vs-session header.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { agent } = await params;
  const bad = badUsername(agent);
  if (bad) return bad;
  const username = agent.trim().toLowerCase();

  const gated = await ipGate(
    req,
    "reviews",
    "IP_RATE_LIMIT_REVIEWS",
    60,
    "too many review submissions from this network — try again later",
  );
  if (gated) return gated;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Auth: signed wallet session. 401 without.
  const cred = sessionCredentialFrom(req);
  if (!cred) {
    return NextResponse.json(
      { error: "sign in with your wallet to leave a review" },
      { status: 401 },
    );
  }
  const authRes = await defaultAuthPort().verifySession(cred);
  if (!authRes.ok) {
    return NextResponse.json({ error: authRes.error }, { status: 401 });
  }
  const sessionAddress = authRes.session.address; // canonical lowercase 0x

  const input = validateReviewInput(body);
  if (!input.ok) {
    return NextResponse.json({ error: input.error }, { status: 400 });
  }

  // The reviewed page must exist on-chain; resolve its owner.
  let owner: string | null;
  try {
    owner = await defaultRegistryPort().resolveOwner(username);
  } catch {
    return NextResponse.json(
      { error: "registry unavailable — try again in a moment" },
      { status: 503 },
    );
  }
  if (!owner) {
    return NextResponse.json(
      { error: `page "${username}" is not registered` },
      { status: 404 },
    );
  }
  const agentOwner = canonicalAddress(owner);
  if (!agentOwner) {
    return NextResponse.json(
      { error: "registry returned an unreadable owner address" },
      { status: 503 },
    );
  }
  if (sessionAddress === agentOwner) {
    return NextResponse.json({ error: "cannot review your own page" }, { status: 400 });
  }

  // Content safety before anything is stored.
  if (input.input.text) {
    const check = checkContent(input.input.text, "review");
    if (!check.allowed) {
      return NextResponse.json(
        { error: `review blocked: ${check.reason ?? "not allowed"}` },
        { status: 400 },
      );
    }
  }

  // The proof: a settled Tips-contract transaction where this wallet paid
  // this agent's owner. Fails closed on any mirror-node problem.
  const tipsAddress = getTipsAddress();
  if (!tipsAddress) {
    return NextResponse.json(
      { error: "tips contract is not configured" },
      { status: 503 },
    );
  }
  const proven = await verifyReviewTx(input.input.txId, sessionAddress, agentOwner, {
    fetchFn: fetch,
    mirrorBaseUrl: mirrorBaseUrl(),
    tipsAddress,
  });
  if (!proven.ok) {
    return NextResponse.json({ error: proven.error }, { status: proven.status });
  }

  // One review per transaction, claimed atomically.
  let claimed: boolean;
  try {
    claimed = await claimReviewTx(input.input.txId);
  } catch {
    return NextResponse.json(
      { error: "could not record the review — try again in a moment" },
      { status: 503 },
    );
  }
  if (!claimed) {
    return NextResponse.json(
      { error: "this transaction already backs a review" },
      { status: 409 },
    );
  }

  // Reviewer page username is best-effort display metadata, never trusted.
  let reviewerUsername: string | null = null;
  try {
    reviewerUsername = await resolveUsernameForOwner(sessionAddress);
  } catch {
    reviewerUsername = null;
  }

  const review: VerifiedReview = {
    txId: input.input.txId,
    kind: proven.kind,
    reviewer: sessionAddress,
    reviewerUsername,
    rating: input.input.rating,
    text: input.input.text,
    timestamp: new Date().toISOString(),
  };
  try {
    await addReview(username, review);
  } catch {
    return NextResponse.json(
      { error: "could not record the review — try again in a moment" },
      { status: 503 },
    );
  }

  let summary = null;
  try {
    summary = await getReviewSummary(username);
  } catch {
    summary = null;
  }
  return NextResponse.json({ review, summary }, { status: 201 });
}
