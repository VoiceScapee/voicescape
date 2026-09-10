import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { defaultDeps, postChat, type PostChatBody } from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * POST /api/townhall/chat/[room] {author,body,dustFeeTxId}
 * Dust fee required. 201 → {seq}.
 */
export async function POST(req: NextRequest, { params }: { params: { room: string } }) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { status, json } = await postChat(defaultDeps(), params.room, withAuth((body ?? {}) as PostChatBody, req));
  return NextResponse.json(json, { status });
}
