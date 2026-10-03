import { NextRequest, NextResponse } from "next/server";
import { getObligation } from "@/lib/server/obligations";

export const runtime = "nodejs";

/**
 * GET /api/obligations?tx=<transaction id> — public read of one payment's
 * obligation lifecycle: the settled payment (chain-verified) plus every
 * merchant/payer attestation (fulfilled, disputed, refunded).
 *
 * 404 means no obligation record exists for this transaction — the chain
 * receipt itself is the current record. Absence of a record is not evidence
 * of anything about the payment.
 */

export async function GET(req: NextRequest): Promise<NextResponse> {
  const tx = req.nextUrl.searchParams.get("tx") ?? "";
  if (!tx.trim()) {
    return NextResponse.json({ error: "tx query parameter is required" }, { status: 400 });
  }
  const obligation = await getObligation(tx);
  if (!obligation) {
    return NextResponse.json(
      { error: "no obligation record for this transaction — the chain receipt is the current record" },
      { status: 404 },
    );
  }
  return NextResponse.json({ obligation });
}
