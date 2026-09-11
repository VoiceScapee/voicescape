import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import { defaultDeps, postChat, type PostChatBody } from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * POST /api/townhall/chat/[room] {author,body,dustFeeTxId}
 * Dust fee required. 201 → {seq}.
 */
export async function POST(req: NextRequest, { params }: { params: { room: string } }) {
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
  const { status, json } = await postChat(defaultDeps(), params.room, withAuth((body ?? {}) as PostChatBody, req));
  return NextResponse.json(json, { status });
}
