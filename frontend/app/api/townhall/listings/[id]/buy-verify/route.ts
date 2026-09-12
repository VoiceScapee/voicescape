import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { defaultDeps, verifyBuySeller } from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * POST /api/townhall/listings/[id]/buy-verify
 * → { verified: true, sellerAddress } | { verified: false, reason }
 *
 * Server-side buy pre-check. The listing page calls this BEFORE building or
 * signing any buyListing transaction; a negative verdict means no
 * transaction is ever built (zero gas burned on doomed buys). On success
 * the buyer must pay `sellerAddress` (the registry-resolved owner in
 * canonical alias form) — never the raw long-zero form from the listing.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  // Per-IP flood bound — this does mirror/registry reads per call.
  const gated = await ipGate(
    req,
    "townhall",
    "IP_RATE_LIMIT_TOWNHALL",
    300,
    "too many verification requests — try again later",
  );
  if (gated) return gated;
  const { status, json } = await verifyBuySeller(defaultDeps(), params.id);
  return NextResponse.json(json, { status });
}
