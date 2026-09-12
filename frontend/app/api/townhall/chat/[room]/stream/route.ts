import { NextRequest, NextResponse } from "next/server";
import {
  defaultDeps,
  queryChatMessages,
} from "@/lib/server/townhall/handlers";
import { createSseStream, sinceParam } from "@/lib/server/townhall/sse";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { verifySessionToken } from "@/lib/server/townhall/auth";
import { BUILDERS_ROOM_ID, BUILDER_UNLOCK_MESSAGE, hasBuilderBadge } from "@/lib/server/badges";

export const runtime = "nodejs";

/**
 * GET /api/townhall/chat/[room]/stream?since=<seq> — Server-Sent Events.
 * Emits `data: {"seq":..,"room":..,"author":..,"body":..,"ts":..}` for each
 * new chat message in the room (polls the chat topic every 5s), plus
 * `: keepalive` comments. Closes when the client disconnects.
 *
 * The builders room is gated: reading it requires a signed wallet session
 * whose address holds the Builder badge. 401 → no/invalid session,
 * 403 → session valid but no badge.
 */
export async function GET(req: NextRequest, { params }: { params: { room: string } }) {
  const room = params.room;
  if (room === BUILDERS_ROOM_ID) {
    const cred = sessionCredentialFrom(req);
    const verified = typeof cred === "string" ? verifySessionToken(cred) : null;
    if (!verified || !verified.ok) {
      return NextResponse.json(
        { error: verified && !verified.ok ? verified.error : "missing session: sign in with your wallet" },
        { status: 401 },
      );
    }
    if (!(await hasBuilderBadge(verified.session.address))) {
      return NextResponse.json({ error: BUILDER_UNLOCK_MESSAGE }, { status: 403 });
    }
  }
  const deps = defaultDeps();
  return createSseStream(req.signal, (afterSeq) => queryChatMessages(deps, room, afterSeq), sinceParam(req.url));
}
