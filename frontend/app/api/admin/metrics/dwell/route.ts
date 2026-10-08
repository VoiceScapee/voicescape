import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultDwellAdminDeps, getDwellStatsAdmin } from "@/lib/server/dwell";

export const runtime = "nodejs";

/**
 * GET /api/admin/metrics/dwell
 *
 * Founder-only dwell-time stats (last 7 days): completions, dwell
 * histogram buckets, validation violations, cohort flow counts.
 * Same wallet-session founder gate as /api/admin/metrics.
 *
 * 401 bad/missing session · 403 not a founder · 200 { days, dayCount }.
 * Aggregates contain no PII by construction (see lib/server/dwell.ts).
 */
export async function GET(req: NextRequest) {
  const cred = sessionCredentialFrom(req);
  const { status, json } = await getDwellStatsAdmin(defaultDwellAdminDeps(), cred);
  return NextResponse.json(json, { status });
}
