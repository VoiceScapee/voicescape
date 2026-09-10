import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import {
  defaultDeps,
  getModStatus,
  type ModStatusBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * GET /api/townhall/mod-status?username=<page>&wall=<page?>
 *
 * Tells the UI whether the signed-in identity may moderate:
 * {username, isMod, canModerateWall}. The username must resolve on-chain to
 * the session wallet (requirePageOwner) unless the session wallet itself is
 * a TOWNHALL_MOD_WALLETS mod wallet, which needs no registered page —
 * 401 without a valid session, 403 when the claimed username isn't owned
 * by the wallet (and the wallet isn't a mod wallet).
 */
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const body = withAuth(
    {
      username: sp.get("username") ?? undefined,
      wall: sp.get("wall") ?? undefined,
    } satisfies ModStatusBody,
    req,
  );
  const { status, json } = await getModStatus(defaultDeps(), body);
  return NextResponse.json(json, { status });
}
