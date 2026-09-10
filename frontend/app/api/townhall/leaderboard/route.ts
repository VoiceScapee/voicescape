import { NextResponse } from "next/server";
import {
  computeLeaderboard,
  defaultDepsForBadges,
} from "@/lib/server/townhall/badges";

export const runtime = "nodejs";

/**
 * GET /api/townhall/leaderboard
 *
 * Top 20 town hall users by activity score. Public, session-less read.
 * Scores derive from HCS activity (chat, posts, rooms, listings, positive
 * votes); the stats blob is cached 5 minutes.
 *
 * 200 → {leaders:[{username, wallet, score, badgeCount, topBadge}]}.
 */
export async function GET() {
  const leaders = await computeLeaderboard(defaultDepsForBadges().hcs);
  return NextResponse.json({ leaders });
}
