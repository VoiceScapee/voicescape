import { NextResponse } from "next/server";
import { getMarketLeaderboards } from "@/lib/server/townhall/market-leaders";

export const runtime = "nodejs";

/**
 * GET /api/townhall/leaderboard/market
 *
 * Top 10 tippers, buyers, and sellers — on-chain data only (Tips contract
 * TipSent + PurchaseCompleted mirror-node logs, cached 10 minutes).
 * Public, session-less read.
 *
 * 200 → { tippers, buyers, sellers, scannedAt }, each entry
 * { address, totalHbar, count }. Empty arrays when nothing is on-chain yet
 * (honest empty state — never invented numbers).
 */
export async function GET() {
  const boards = await getMarketLeaderboards();
  return NextResponse.json(boards);
}
