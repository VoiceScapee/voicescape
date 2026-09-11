import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  defaultDeps,
  setListingStatus,
  type SetListingStatusBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * POST /api/townhall/listings/[id]/status {seller,status}
 * Seller-only (403 otherwise); status "sold" | "cancelled". → {}.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  // Per-IP flood bound in front of the per-wallet free-write quota.
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
  const { status, json } = await setListingStatus(
    defaultDeps(),
    params.id,
    withAuth((body ?? {}) as SetListingStatusBody, req),
  );
  return NextResponse.json(json, { status });
}
