import { NextResponse } from "next/server";
import { getTopicId } from "@/lib/server/townhall/topics";

/**
 * GET /api/townhall/topics
 * Public topic IDs for client-side HCS submits. Topic IDs are public
 * on-chain data, not secrets.
 */
export async function GET() {
  return NextResponse.json({
    forum: getTopicId("forum"),
    chat: getTopicId("chat"),
    votes: getTopicId("votes"),
    governance: getTopicId("governance"),
    market: getTopicId("market"),
  });
}
