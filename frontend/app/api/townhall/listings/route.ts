import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  createListing,
  defaultDeps,
  getListings,
  type CreateListingBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * GET /api/townhall/listings
 * → {listings:[{id,seller,title,description,priceUsdCents,goodsType,ipfsHash,status,ts}]}
 * Latest message per id wins (status updates included).
 */
export async function GET() {
  const { status, json } = await getListings(defaultDeps());
  return NextResponse.json(json, { status });
}

/**
 * POST /api/townhall/listings
 * {seller,title,description,priceUsdCents,goodsType,ipfsHash?,dustFeeTxId}
 * Dust fee required; seller must be registered. 201 → {id}.
 */
export async function POST(req: NextRequest) {
  // Per-IP flood bound in front of the per-wallet quotas and dust fees.
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
  const { status, json } = await createListing(defaultDeps(), withAuth((body ?? {}) as CreateListingBody, req));
  return NextResponse.json(json, { status });
}
