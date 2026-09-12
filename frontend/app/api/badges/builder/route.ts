import { NextRequest, NextResponse } from "next/server";
import { builderBadgeProgress } from "@/lib/server/badges";
import { canonicalAddress } from "@/lib/session-message";

export const runtime = "nodejs";

/**
 * GET /api/badges/builder?wallet=0x… (or 0.0.x)
 *
 * Builder-badge progress for a wallet. Public, session-less read — badge
 * progress is social proof. 200 → {hasPage, hasTip, complete}.
 * Errors: 400 missing/invalid wallet.
 */
export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim();
  if (!wallet || !canonicalAddress(wallet)) {
    return NextResponse.json({ error: "a valid wallet address is required" }, { status: 400 });
  }
  return NextResponse.json(await builderBadgeProgress(wallet));
}
