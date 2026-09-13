import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultConversionAdminDeps, getConversionStatsAdmin } from "@/lib/server/conversion";

export const runtime = "nodejs";

/**
 * GET /api/admin/metrics
 *
 * Founder-only aggregate conversion stats (last 7 days, per event).
 * The request must carry a valid wallet session (x-vs-session) whose
 * address is a founder wallet (FOUNDER_WALLETS env, falling back to the
 * public treasury address).
 *
 * 401 bad/missing session · 403 not a founder · 200 { days, dayCount }.
 * Aggregates contain no PII by construction (see conversion.ts).
 */
export async function GET(req: NextRequest) {
  const cred = sessionCredentialFrom(req);
  const { status, json } = await getConversionStatsAdmin(defaultConversionAdminDeps(), cred);
  return NextResponse.json(json, { status });
}
