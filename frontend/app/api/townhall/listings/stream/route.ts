import { NextRequest } from "next/server";
import {
  defaultDeps,
  queryListingViews,
} from "@/lib/server/townhall/handlers";
import { createSseStream, sinceParam } from "@/lib/server/townhall/sse";

export const runtime = "nodejs";

/**
 * GET /api/townhall/listings/stream?since=<seq> — Server-Sent Events.
 * Emits `data: {id, seller, sellerUsername, title, description,
 * priceUsdCents, goodsType, ipfsHash, status, ts}` for each new listing
 * message (polls the market topic every 5s), plus `: keepalive` comments.
 * Same shape as GET /api/townhall/listings; clients upsert by id.
 */
export async function GET(req: NextRequest) {
  const deps = defaultDeps();
  return createSseStream(req.signal, (afterSeq) => queryListingViews(deps, afterSeq), sinceParam(req.url));
}
