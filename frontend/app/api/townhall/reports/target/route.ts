import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import {
  defaultDeps,
  resolveReportTarget,
  type ResolveReportTargetBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * GET /api/townhall/reports/target?targetKind=post|chat|listing|profile&targetSeq=N&targetId=x
 *
 * Resolve a report's target to the offending identity: the author's
 * registered username and canonical wallet address, so a moderator can
 * issue warn/timeout/ban from the report queue. Mod-only (TOWNHALL_MODS
 * username or TOWNHALL_MOD_WALLETS wallet). Session from the
 * x-vs-session header.
 * 200 → {username, wallet}.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const rawSeq = q.get("targetSeq");
  const { status, json } = await resolveReportTarget(
    defaultDeps(),
    withAuth(
      {
        targetKind: q.get("targetKind"),
        targetSeq: rawSeq === null || rawSeq === "" ? undefined : Number(rawSeq),
        targetId: q.get("targetId") ?? undefined,
      } as ResolveReportTargetBody,
      req,
    ),
  );
  return NextResponse.json(json, { status });
}
