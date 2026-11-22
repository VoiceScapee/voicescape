import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { withAuth } from "@/lib/server/townhall/route-auth";
import {
  defaultGuestCommentsDeps,
  hideGuestComment,
} from "@/lib/server/guest-comments/handlers";

export const runtime = "nodejs";

/**
 * POST /api/guest-comments/[page]/[thread]/hide {id} — page-owner
 * moderation. Requires a signed wallet session for the page owner.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ page: string; thread: string }> }) {
  const gated = await ipGate(
    req,
    "guest-comments-hide",
    "IP_RATE_LIMIT_GUEST_COMMENTS_HIDE",
    30,
    "too many moderation requests from this network — try again later",
  );
  if (gated) return gated;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { page, thread } = await params;
  const input = withAuth((body ?? {}) as { id?: unknown }, req);
  const { status, json } = await hideGuestComment(
    defaultGuestCommentsDeps(),
    page,
    thread,
    input.id,
    (input as { auth?: unknown }).auth,
  );
  return NextResponse.json(json, { status });
}
