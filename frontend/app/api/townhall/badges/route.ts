import { NextRequest, NextResponse } from "next/server";
import {
  computeBadges,
  defaultDepsForBadges,
} from "@/lib/server/townhall/badges";

export const runtime = "nodejs";

/**
 * GET /api/townhall/badges?username=foo[&wallet=0.0.x]
 *
 * Badges for one user. Public, session-less read — badges are social
 * proof. HCS-derived badges need only the username; payment, agent, and
 * clean-record badges additionally need the wallet (query param).
 *
 * 200 → {username, badges:[{id,name,description,icon,category}], stats}.
 * Errors: 400 missing username.
 */
export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username")?.trim();
  if (!username) {
    return NextResponse.json({ error: "username is required" }, { status: 400 });
  }
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim() || undefined;
  const result = await computeBadges(defaultDepsForBadges().hcs, { username, wallet });
  return NextResponse.json(result);
}
