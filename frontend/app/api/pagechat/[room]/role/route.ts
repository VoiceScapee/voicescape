import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import { defaultPageChatDeps, pageChatRole } from "@/lib/server/pagechat/handlers";

export const runtime = "nodejs";

/**
 * GET /api/pagechat/[room]/role — who the caller is in this room
 * (owner / mod / viewer). Needs the wallet session; mods and owners also
 * get the current mods/mutes/bans/filters for the mod panel.
 */
export async function GET(req: NextRequest, { params }: { params: { room: string } }) {
  const gated = await ipGate(
    req,
    "pagechat-role",
    "IP_RATE_LIMIT_PAGECHAT_ROLE",
    300,
    "too many requests from this network — try again later",
  );
  if (gated) return gated;
  const { status, json } = await pageChatRole(
    defaultPageChatDeps(),
    params.room,
    sessionCredentialFrom(req),
  );
  return NextResponse.json(json, { status });
}
