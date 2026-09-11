import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import {
  defaultDeps,
  searchListings,
  type SearchListingsParams,
} from "@/lib/server/townhall/handlers";
import { siteUrl } from "@/lib/seo";

export const runtime = "nodejs";

/**
 * GET /api/townhall/market/search?q=&category=&minPrice=&maxPrice=&sort=&limit=
 *
 * Public marketplace search — no wallet session required. Built for
 * external AI agents (price comparison, deal finding) and anyone else
 * who wants machine-readable access to active listings.
 *
 * Query params:
 *   q         — free-text match against title + description
 *   category  — "physical" | "digital"
 *   minPrice  — minimum price in USD cents
 *   maxPrice  — maximum price in USD cents
 *   sort      — "newest" (default) | "price-asc" | "price-desc"
 *   limit     — 1..100, default 50
 *
 * 200 → {listings:[{id,seller,sellerUsername,title,description,
 *        priceUsdCents,goodsType,ipfsHash,status,ts,url}], count}.
 * Only active listings are returned. Rate-limited per IP to prevent
 * scraping abuse.
 */
export async function GET(req: NextRequest) {
  const gated = await ipGate(
    req,
    "market-search",
    "IP_RATE_LIMIT_MARKET_SEARCH",
    120,
    "too many marketplace searches from this network — try again later",
  );
  if (gated) return gated;

  const sp = req.nextUrl.searchParams;
  const num = (v: string | null): number | undefined => {
    if (v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const sortRaw = sp.get("sort");
  const sort: SearchListingsParams["sort"] =
    sortRaw === "price-asc" || sortRaw === "price-desc" ? sortRaw : "newest";

  const params: SearchListingsParams = {
    q: sp.get("q") ?? undefined,
    category: sp.get("category") ?? undefined,
    minPriceCents: num(sp.get("minPrice")),
    maxPriceCents: num(sp.get("maxPrice")),
    sort,
    limit: num(sp.get("limit")),
  };

  const { status, json } = await searchListings(defaultDeps(), params, siteUrl());
  return NextResponse.json(json, { status });
}
