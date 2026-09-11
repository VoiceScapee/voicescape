import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import {
  defaultDeps,
  listWarnings,
  type ListWarningsBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * GET /api/townhall/warnings
 *
 * Active warnings list, newest first. Mod-only (TOWNHALL_MODS username
 * or TOWNHALL_MOD_WALLETS wallet). Session from the x-vs-session header.
 * 200 → {warnings: WarnView[]}.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const { status, json } = await listWarnings(
    defaultDeps(),
    withAuth({ username: q.get("username") ?? undefined } as ListWarningsBody, req),
  );
  return NextResponse.json(json, { status });
}
