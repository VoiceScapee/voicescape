import { NextRequest } from "next/server";
import {
  defaultDeps,
  queryPostViews,
} from "@/lib/server/townhall/handlers";
import { createSseStream, sinceParam } from "@/lib/server/townhall/sse";

export const runtime = "nodejs";

/**
 * GET /api/townhall/posts/stream?board=<board>&since=<seq> — Server-Sent Events.
 * Emits `data: {seq, board, wall, author, body, replyTo, ts}` for each new
 * forum post (polls the forum topic every 5s), plus `: keepalive` comments.
 * Same shape as GET /api/townhall/posts; mod-hides apply.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const board = url.searchParams.get("board");
  const deps = defaultDeps();
  return createSseStream(req.signal, (afterSeq) => queryPostViews(deps, board, afterSeq), sinceParam(req.url));
}
