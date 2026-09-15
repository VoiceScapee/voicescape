import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { issueOrder } from "@/lib/server/a2a-paid/orders";

/**
 * POST /api/a2a/orders — Phase 5 paid endpoint prototype (TESTNET ONLY).
 *
 * Body: { product: "chat-50" | "blockpage-build", buyerAccount: "0.0.x" }
 * Success: HTTP 402 + the bill (payment required, here's how).
 * The buyer pays from their own wallet via tipPage on the testnet Tips
 * contract with the order-bound memo; the server never holds spend keys.
 */
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "a2a-orders",
    "IP_RATE_LIMIT_A2A_ORDERS",
    60,
    "too many order requests from this network — try again later",
  );
  if (gated) return gated;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const result = await issueOrder({
    product: (body as { product?: string })?.product ?? "",
    buyerAccount: (body as { buyerAccount?: string })?.buyerAccount ?? "",
  });

  if (result.ok) {
    // 402 Payment Required — the bill IS the response.
    return NextResponse.json(result.bill, { status: 402 });
  }

  const err = result.error;
  switch (err.code) {
    case "invalid_product":
    case "invalid_buyer_account":
      return NextResponse.json(
        { error: err.code, products: ["chat-50", "blockpage-build"] },
        { status: 400 },
      );
    case "insufficient_balance":
    case "account_not_found":
      return NextResponse.json({ error: err.code, ...err }, { status: 402 });
    case "misconfigured":
      return NextResponse.json(
        { error: "temporarily unavailable — please try again later" },
        { status: 503 },
      );
  }
}
