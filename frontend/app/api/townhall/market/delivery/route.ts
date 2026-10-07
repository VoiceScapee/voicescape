import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { defaultDeps, getListingById } from "@/lib/server/townhall/handlers";
import { verifyPurchase } from "@/lib/server/townhall/badges";

export const runtime = "nodejs";

/** Public IPFS gateway used for buyer downloads. */
const DIGITAL_GOOD_GATEWAY = "https://ipfs.io/ipfs";

/**
 * GET /api/townhall/market/delivery?listingId=…&wallet=…
 * → { url } | { error }
 *
 * Verified-buyer file delivery for digital listings. The server checks the
 * Tips contract's PurchaseCompleted logs on the mirror node: only a wallet
 * with a real on-chain purchase of this listing gets the file URL.
 *
 * Honest framing: IPFS content is public by its hash — this endpoint is a
 * verified-buyer *reveal* (the buyer proved they paid), not DRM. Anyone
 * who already knows the CID can fetch it from any gateway.
 */
export async function GET(req: NextRequest) {
  const gated = await ipGate(
    req,
    "townhall",
    "IP_RATE_LIMIT_TOWNHALL",
    300,
    "too many requests from this network — try again later",
  );
  if (gated) return gated;

  const params = req.nextUrl.searchParams;
  const listingId = (params.get("listingId") ?? "").trim();
  const wallet = (params.get("wallet") ?? "").trim();
  if (!listingId || !wallet) {
    return NextResponse.json({ error: "listingId and wallet are required" }, { status: 400 });
  }

  const listing = await getListingById(defaultDeps(), listingId);
  if (!listing) {
    return NextResponse.json({ error: "listing not found" }, { status: 404 });
  }
  if (listing.goodsType !== "digital" || !listing.ipfsHash) {
    return NextResponse.json(
      { error: "this listing has no digital file attached" },
      { status: 404 },
    );
  }

  const ok = await verifyPurchase(wallet, listingId);
  if (!ok) {
    return NextResponse.json(
      { error: "no verified on-chain purchase of this listing for that wallet" },
      { status: 403 },
    );
  }

  return NextResponse.json({ url: `${DIGITAL_GOOD_GATEWAY}/${listing.ipfsHash}` });
}
