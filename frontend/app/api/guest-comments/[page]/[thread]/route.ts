import { NextRequest, NextResponse } from "next/server";
import { clientIpFromHeaders, ipGate } from "@/lib/server/rate-limit";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import {
  defaultGuestCommentsDeps,
  listGuestComments,
  postGuestComment,
} from "@/lib/server/guest-comments/handlers";

export const runtime = "nodejs";

/**
 * GET /api/guest-comments/[page]/[thread] — public comment list.
 * Carries `canModerate` when the caller is signed in as the page owner.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ page: string; thread: string }> }) {
  const gated = await ipGate(
    req,
    "guest-comments-read",
    "IP_RATE_LIMIT_GUEST_COMMENTS_READ",
    300,
    "too many comment reads from this network — try again later",
  );
  if (gated) return gated;
  const { page, thread } = await params;
  const { status, json } = await listGuestComments(
    defaultGuestCommentsDeps(),
    page,
    thread,
    sessionCredentialFrom(req),
  );
  return NextResponse.json(json, { status });
}

/**
 * POST /api/guest-comments/[page]/[thread] {name, body, parentId?} —
 * no-login guest comment. Rate-limited per IP; reserved names rejected.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ page: string; thread: string }> }) {
  const gated = await ipGate(
    req,
    "guest-comments-post",
    "IP_RATE_LIMIT_GUEST_COMMENTS_POST",
    30,
    "too many comments from this network — try again later",
  );
  if (gated) return gated;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { page, thread } = await params;
  const { status, json } = await postGuestComment(
    defaultGuestCommentsDeps(),
    page,
    thread,
    (body ?? {}) as { name?: unknown; body?: unknown; parentId?: unknown },
  );
  return NextResponse.json(json, { status });
}
