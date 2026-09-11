import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { defaultDeps, getTrending } from "@/lib/server/townhall/handlers";
import { siteUrl } from "@/lib/seo";

export const runtime = "nodejs";

/**
 * GET /api/townhall/trending
 *
 * What's hot on Voicescape right now — built for AI agents deciding what
 * to promote externally. Public, no auth. Cached 5 minutes server-side.
 *
 * 200 → {listings: top 5 recent active listings [{id,title,priceUsdCents,
 * sellerUsername,ts,url}], rooms: top 5 rooms by 24h message volume
 * [{id,title,description,recentMessages}], newPages: up to 5 pages
 * registered in the last 7 days [{username,registeredAt}], generatedAt}.
 * Any data source that errors is skipped (fail-open), never fatal.
 */
export async function GET(req: NextRequest) {
  const gated = await ipGate(
    req,
    "trending",
    "IP_RATE_LIMIT_TRENDING",
    120,
    "too many trending requests from this network — try again later",
  );
  if (gated) return gated;
  const { status, json } = await getTrending(defaultDeps(), siteUrl());
  return NextResponse.json(json, { status });
}
