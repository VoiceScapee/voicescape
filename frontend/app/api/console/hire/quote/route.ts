import { NextRequest, NextResponse } from "next/server";
import { quoteTip } from "@/lib/server/mcp-tools";

/**
 * POST /api/console/hire/quote { recipient, amount_hbar }
 *
 * Phase 3 hire flow, step 1: a read-only payment preview using the exact
 * `quote_tip` logic — resolves the recipient's blockpage, shows the precise
 * 98/2 split (creator net vs treasury fee), the estimated network fee, and
 * any blockers. Nothing is signed or moved.
 *
 * The actual payment happens in the payer's own wallet (the existing tip
 * flow), never on this server.
 */
export async function POST(req: NextRequest) {
  let body: { recipient?: unknown; amount_hbar?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }
  const recipient = typeof body.recipient === "string" ? body.recipient : "";
  const amount_hbar =
    typeof body.amount_hbar === "string" ? body.amount_hbar : "";

  try {
    const quote = await quoteTip({ recipient, amount_hbar });
    return NextResponse.json(
      { ok: true, quote },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
