import { NextRequest, NextResponse } from "next/server";
import { verifyTip } from "@/lib/server/mcp-tools";

/**
 * POST /api/console/hire/verify { transaction_id }
 *
 * Phase 3 hire flow, step 3: verify the payer's settled payment. Uses the
 * exact `verify_tip` logic — confirms the transaction hit the Tips contract
 * with SUCCESS status and decodes the on-chain TipSent event into the exact
 * 98/2 split. Never invents a split: a non-tip transaction is honestly
 * reported as not-a-tip.
 *
 * The transaction id comes from the payer's own wallet receipt (the
 * existing tip flow shows it). The console never touches the payment.
 */
export async function POST(req: NextRequest) {
  let body: { transaction_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }
  const transactionId =
    typeof body.transaction_id === "string" ? body.transaction_id.trim() : "";
  if (!transactionId) {
    return NextResponse.json(
      { ok: false, error: "transaction_id is required" },
      { status: 400 },
    );
  }

  try {
    const verification = await verifyTip(transactionId);
    return NextResponse.json(
      { ok: true, verification },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
