import { NextResponse } from "next/server";
import { defaultFundraiserDeps, listFundraisers } from "@/lib/server/fundraisers";

export const runtime = "nodejs";

/**
 * GET /api/fundraisers — public read.
 * 200 → { fundraisers: FundraiserEntry[] } (newest first)
 *
 * Aggregates every creator funding goal into fundraiser-board cards:
 * goal record + owner address + all-time on-chain tips (mirror node).
 * Never 500s — failures degrade to an empty board or skipped entries.
 */
export async function GET() {
  try {
    const fundraisers = await listFundraisers(defaultFundraiserDeps());
    return NextResponse.json({ fundraisers });
  } catch {
    return NextResponse.json({ fundraisers: [] });
  }
}
