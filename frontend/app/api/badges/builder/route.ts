import { NextRequest, NextResponse } from "next/server";
import { builderBadgeProgress } from "@/lib/server/badges";
import { canonicalAddress } from "@/lib/session-message";

export const runtime = "nodejs";

/**
 * GET /api/badges/builder?wallet=0x… (or 0.0.x)[&force=1]
 *
 * Builder-badge progress for a wallet. Public, session-less read — badge
 * progress is social proof. 200 → {hasPage, hasTip, complete}.
 * Pass force=1 to bypass the cache and recompute from the Mirror Node
 * (manual "recheck" after receiving a tip).
 * Errors: 400 missing/invalid wallet.
 */
export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim();
  if (!wallet || !canonicalAddress(wallet)) {
    return NextResponse.json({ error: "a valid wallet address is required" }, { status: 400 });
  }
  const force = req.nextUrl.searchParams.get("force") === "1";
  return NextResponse.json(await builderBadgeProgress(wallet, force));
}
