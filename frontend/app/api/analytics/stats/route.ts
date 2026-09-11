import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultAnalyticsDeps, getCreatorStats } from "@/lib/server/analytics";

export const runtime = "nodejs";

/**
 * GET /api/analytics/stats?username=<name>
 *
 * Creator analytics dashboard data. Owner-only: the request must carry a
 * valid wallet session (x-vs-session) whose address owns the username
 * on-chain. 401 bad/missing session · 400 bad username · 403 not the
 * owner · 404 page not found.
 *
 * 200 → { username, totalViews, viewsLast7d, viewsLast30d,
 *          daily: [{date, views}…×30], topSubjects: [{subject, label, views}…],
 *          totalTipsHbar, tipsCount, totalReferrals, badgesEarned }
 */
export async function GET(req: NextRequest) {
  const cred = sessionCredentialFrom(req);
  const username = req.nextUrl.searchParams.get("username") ?? "";
  const { status, json } = await getCreatorStats(defaultAnalyticsDeps(), username, cred);
  return NextResponse.json(json, { status });
}
