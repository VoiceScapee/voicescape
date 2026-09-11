import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  banUser,
  defaultDeps,
  listBans,
  unbanUser,
  type BanUserBody,
  type ListBansBody,
  type UnbanUserBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * GET /api/townhall/bans
 *
 * Active enforcement list: current bans (temp + permanent) and timeouts,
 * newest first. Mod-only (TOWNHALL_MODS username or TOWNHALL_MOD_WALLETS
 * wallet). Session from the x-vs-session header.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const { status, json } = await listBans(
    defaultDeps(),
    withAuth({ username: q.get("username") ?? undefined } as ListBansBody, req),
  );
  return NextResponse.json(json, { status });
}

/**
 * POST /api/townhall/bans {wallet, targetUsername?, reason, expiresAt?}
 *
 * Ban a wallet (temp ban with expiresAt, permanent without). Mod-only.
 * 201 → {seq, wallet}. Errors: 400 bad input, 401 no session, 403 not a
 * moderator, 409 wallet already restricted.
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
  const { status, json } = await banUser(defaultDeps(), withAuth((body ?? {}) as BanUserBody, req));
  return NextResponse.json(json, { status });
}

/**
 * DELETE /api/townhall/bans {wallet}
 *
 * Lift a wallet's enforcement state (warning, timeout, or ban).
 * Mod-only.
 * 201 → {seq, wallet}. Errors: 400 bad input, 401 no session, 403 not a
 * moderator, 404 wallet has no enforcement record to lift.
 */
export async function DELETE(req: NextRequest) {
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
  const { status, json } = await unbanUser(defaultDeps(), withAuth((body ?? {}) as UnbanUserBody, req));
  return NextResponse.json(json, { status });
}
