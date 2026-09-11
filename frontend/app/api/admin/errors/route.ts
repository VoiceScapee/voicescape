import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultClientErrorAdminDeps, getClientErrorStats } from "@/lib/server/client-errors";

export const runtime = "nodejs";

/**
 * GET /api/admin/errors
 *
 * Founder-only client-error aggregates (last 7 days, sorted by count).
 * The request must carry a valid wallet session (x-vs-session) whose
 * address is a founder wallet (FOUNDER_WALLETS env, falling back to the
 * public treasury address).
 *
 * 401 bad/missing session · 403 not a founder · 200 { errors, days }.
 * Error aggregates contain no PII by construction (see client-errors.ts).
 */
export async function GET(req: NextRequest) {
  const cred = sessionCredentialFrom(req);
  const { status, json } = await getClientErrorStats(defaultClientErrorAdminDeps(), cred);
  return NextResponse.json(json, { status });
}
