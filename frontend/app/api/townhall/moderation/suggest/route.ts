import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import {
  defaultDeps,
  suggestEnforcementAction,
  type SuggestEnforcementBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * GET /api/townhall/moderation/suggest?wallet=0.0.x&severity=low|medium|high|critical
 *
 * Recommend the next enforcement step from the wallet's HCS history and
 * the violation severity. Mod-only. Advisory — the moderator makes the
 * call and may skip levels for severe violations.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const { status, json } = await suggestEnforcementAction(
    defaultDeps(),
    withAuth(
      { wallet: q.get("wallet"), severity: q.get("severity") } as SuggestEnforcementBody,
      req,
    ),
  );
  return NextResponse.json(json, { status });
}
