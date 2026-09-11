import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  defaultDeps,
  getProfileLinks,
  setProfileLinks,
  type SetProfileLinksBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * GET /api/townhall/profile-links?username=<name>
 * Public, session-less read of a user's cross-platform identity links.
 * 200 → {username, links, ts} ({links:{}} when none set).
 */
export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username") ?? "";
  const { status, json } = await getProfileLinks(defaultDeps(), username);
  return NextResponse.json(json, { status });
}

/**
 * POST /api/townhall/profile-links
 * {username, links: {platform: handleOrUrl}} — the signing wallet must
 * own the claimed page username. No dust fee; per-wallet daily quota
 * applies. 201 → {seq}.
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
  const { status, json } = await setProfileLinks(
    defaultDeps(),
    withAuth((body ?? {}) as SetProfileLinksBody, req),
  );
  return NextResponse.json(json, { status });
}
