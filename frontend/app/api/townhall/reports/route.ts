import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  defaultDeps,
  queryReports,
  submitReport,
  type QueryReportsBody,
  type SubmitReportBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * POST /api/townhall/reports {targetKind:"post"|"chat"|"listing", targetSeq?, targetId?, reason, reporter?}
 *
 * File a safety report. Requires a signed wallet session (no page
 * ownership, no dust fee — reporting is free). The report lands on the
 * same HCS topic as its target as kind "report".
 *
 * 201 → {seq}. Errors: 400 bad input, 401 no session, 404 target not
 * found, 429 daily quota exceeded.
 */
export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "townhall",
    "IP_RATE_LIMIT_TOWNHALL",
    300,
    "too many town hall writes from this network — try again later",
  );
  if (gated) return gated;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { status, json } = await submitReport(
    defaultDeps(),
    withAuth((body ?? {}) as SubmitReportBody, req),
  );
  return NextResponse.json(json, { status });
}

/**
 * GET /api/townhall/reports
 *
 * Moderator report queue: all reports across forum/chat/market topics,
 * newest first. Requires a global moderator session (TOWNHALL_MODS
 * username or TOWNHALL_MOD_WALLETS wallet). Session comes from the
 * x-vs-session header via withAuth.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const { status, json } = await queryReports(
    defaultDeps(),
    withAuth({ username: q.get("username") ?? undefined } as QueryReportsBody, req),
  );
  return NextResponse.json(json, { status });
}
