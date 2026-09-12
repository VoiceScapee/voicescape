import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  createPost,
  defaultDeps,
  getPosts,
  type CreatePostBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * GET /api/townhall/posts?board=&wall=&limit=&before=
 * before = a post seq; returns posts with seq < before (pagination cursor).
 */
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const { status, json } = await getPosts(defaultDeps(), {
    board: sp.get("board") ?? undefined,
    wall: sp.get("wall") ?? undefined,
    limit: sp.get("limit") ?? undefined,
    before: sp.get("before") ?? undefined,
  });
  return NextResponse.json(json, { status });
}

/**
 * POST /api/townhall/posts {board?,wall?,body,replyTo?,hcsTxId,author}
 * User-signed HCS: client submits via wallet first, sends hcsTxId. 201 → {verified}.
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
  const { status, json } = await createPost(defaultDeps(), withAuth((body ?? {}) as CreatePostBody, req));
  return NextResponse.json(json, { status });
}
