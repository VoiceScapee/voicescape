import { NextRequest } from "next/server";
import {
  defaultDeps,
  queryChatMessages,
} from "@/lib/server/townhall/handlers";
import { createSseStream, sinceParam } from "@/lib/server/townhall/sse";

export const runtime = "nodejs";

/**
 * GET /api/townhall/chat/[room]/stream?since=<seq> — Server-Sent Events.
 * Emits `data: {"seq":..,"room":..,"author":..,"body":..,"ts":..}` for each
 * new chat message in the room (polls the chat topic every 5s), plus
 * `: keepalive` comments. Closes when the client disconnects.
 */
export async function GET(req: NextRequest, { params }: { params: { room: string } }) {
  const room = params.room;
  const deps = defaultDeps();
  return createSseStream(req.signal, (afterSeq) => queryChatMessages(deps, room, afterSeq), sinceParam(req.url));
}
