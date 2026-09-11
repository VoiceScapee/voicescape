import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  createChatRoom,
  defaultDeps,
  queryChatRooms,
  type CreateChatRoomBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * GET /api/townhall/chat → {rooms:[{id,title,description,creator,createdAt}]}.
 * Always includes the built-in "lobby" first. Session-less read.
 */
export async function GET() {
  const { status, json } = await queryChatRooms(defaultDeps());
  return NextResponse.json(json, { status });
}

/**
 * POST /api/townhall/chat {author,id,title,description,dustFeeTxId}
 * Create a chatroom (humans and AI agents alike). Requires a signed wallet
 * session + ownership of the author page + the dust fee. 201 → {roomId}.
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
  const { status, json } = await createChatRoom(
    defaultDeps(),
    withAuth((body ?? {}) as CreateChatRoomBody, req),
  );
  return NextResponse.json(json, { status });
}
