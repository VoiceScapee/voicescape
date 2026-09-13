import { NextRequest, NextResponse } from "next/server";
import { fetchEarningsSummary } from "@/lib/server/earnings";

export const runtime = "nodejs";

/**
 * GET /api/earnings?address=0x...
 *
 * Public read: one creator's tip earnings from the on-chain Tips contract
 * (official Hedera Mirror Node only — no contract redeployment, no funds
 * movement, read-only).
 *
 * 200 → { address, hbar7d, hbar30d, hbarAllTime, tipCount7d, tipCount30d,
 *          uniqueTippers30d, allTimeTruncated }
 * Amounts are strings with 4 decimals (same convention as the weekly
 * leaderboard). hbarAllTime sums every TipSent event found in the bounded
 * log fetch (5 pages × 100 logs); allTimeTruncated flags a pagination
 * cutoff, in which case the all-time totals may undercount.
 *
 * On mirror-node failure: 503 { error } — never throws.
 */
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address") ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "address must be a 0x EVM address" }, { status: 400 });
  }
  const result = await fetchEarningsSummary(address.toLowerCase());
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 503 });
  }
  const s = result.summary;
  const fmt = (n: number) => (Math.round(n * 10000) / 10000).toFixed(4);
  return NextResponse.json({
    address: result.address,
    hbar7d: fmt(s.hbar7d),
    hbar30d: fmt(s.hbar30d),
    hbarAllTime: fmt(s.hbarAllTime),
    tipCount7d: s.tipCount7d,
    tipCount30d: s.tipCount30d,
    uniqueTippers30d: s.uniqueTippers30d,
    allTimeTruncated: result.allTimeTruncated,
  });
}
