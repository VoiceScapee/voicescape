import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { clientIpFromHeaders, ipGate } from "@/lib/server/rate-limit";
import { defaultPageChatDeps, listPageChat, postPageChat } from "@/lib/server/pagechat/handlers";

export const runtime = "nodejs";

/**
 * GET /api/pagechat/[room]?since=<id> — public message poll.
 * Returns {messages} newer than `since`.
 */
export async function GET(req: NextRequest, { params }: { params: { room: string } }) {
  const gated = await ipGate(
    req,
    "pagechat-read",
    "IP_RATE_LIMIT_PAGECHAT_READ",
    1500,
    "too many chat reads from this network — try again later",
  );
  if (gated) return gated;
  const url = new URL(req.url);
  const since = parseInt(url.searchParams.get("since") || "0", 10);
  const { status, json } = await listPageChat(defaultPageChatDeps(), params.room, since);
  return NextResponse.json(json, { status });
}

/**
 * POST /api/pagechat/[room] {name, body} — anyone can chat with a username.
 * A wallet session (x-vs-session) is optional; when present the message is
 * marked verified with the author's address.
 */
export async function POST(req: NextRequest, { params }: { params: { room: string } }) {
  const gated = await ipGate(
    req,
    "pagechat-post",
    "IP_RATE_LIMIT_PAGECHAT_POST",
    60,
    "too many chat messages from this network — try again later",
  );
  if (gated) return gated;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const ip = clientIpFromHeaders(req.headers);
  const { status, json } = await postPageChat(
    defaultPageChatDeps(),
    params.room,
    withAuth((body ?? {}) as { name?: unknown; body?: unknown }, req),
    ip,
  );
  return NextResponse.json(json, { status });
}
