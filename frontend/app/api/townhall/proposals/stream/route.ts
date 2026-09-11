import { NextRequest } from "next/server";
import {
  defaultDeps,
  queryProposalEvents,
} from "@/lib/server/townhall/handlers";
import { createSseStream, sinceParam } from "@/lib/server/townhall/sse";

export const runtime = "nodejs";

/**
 * GET /api/townhall/proposals/stream?since=<seq> — Server-Sent Events.
 * Emits `data: {seq, kind: "proposal"|"proposal-vote", id}` for each new
 * proposal or vote (polls the governance topic every 5s), plus `: keepalive`
 * comments. Clients refetch GET /api/townhall/proposals on any event — the
 * list is small, so a refetch is cheaper than streaming tallies.
 */
export async function GET(req: NextRequest) {
  const deps = defaultDeps();
  return createSseStream(req.signal, (afterSeq) => queryProposalEvents(deps, afterSeq), sinceParam(req.url));
}
