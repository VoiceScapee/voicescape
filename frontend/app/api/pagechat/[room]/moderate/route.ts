import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { clientIpFromHeaders, ipGate } from "@/lib/server/rate-limit";
import { defaultPageChatDeps, moderatePageChat } from "@/lib/server/pagechat/handlers";

export const runtime = "nodejs";

/**
 * POST /api/pagechat/[room]/moderate
 * {action, messageId?, target?, word?} — needs the wallet session.
 * delete/mute/ban/unmute/unban/filter-*: owner or mod.
 * promote/demote: owner only, and the target must have a verified wallet
 * (chatted once with their wallet connected) so mod powers can't be claimed
 * by picking someone's username.
 */
export async function POST(req: NextRequest, { params }: { params: { room: string } }) {
  const gated = await ipGate(
    req,
    "pagechat-mod",
    "IP_RATE_LIMIT_PAGECHAT_MOD",
    300,
    "too many moderation actions from this network — try again later",
  );
  if (gated) return gated;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const ip = clientIpFromHeaders(req.headers);
  const { status, json } = await moderatePageChat(
    defaultPageChatDeps(),
    params.room,
    withAuth((body ?? {}) as Record<string, unknown>, req),
    ip,
  );
  return NextResponse.json(json, { status });
}
