import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { verifyX402Forward } from "@/lib/server/x402-forward-verify";

export const runtime = "nodejs";

/**
 * GET /api/x402/verify-forward?paymentTx=0.0.x@seconds.nanos
 *
 * Public, read-only: checks whether the 2% treasury forward for one x402
 * payment actually landed on Hedera mainnet. The x402 flow pays the agent
 * in full and the 2% forward is best-effort — this endpoint makes that
 * forward checkable instead of trust-me.
 *
 * Query: paymentTx — the payment transaction id (0.0.x@seconds.nanos,
 *        0.0.x-seconds-nanos, or 0x hash). Prefer the receipt id from the
 *        x402 PAYMENT-RESPONSE header.
 *
 * 200 → verification result { ok, verified, ... } (verified:false is a
 *        normal outcome, not an error — see `reason` + `detail`).
 * 400 → malformed paymentTx.
 * 404 → mirror node has no such transaction.
 * 429 → per-IP rate limit. 502 → mirror node unreachable mid-check.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const gated = await ipGate(
    req,
    "x402-verify-forward",
    "IP_RATE_LIMIT_X402_VERIFY_FORWARD",
    30,
    "x402 forward-verify rate limit exceeded (30/hour per IP)",
  );
  if (gated) return gated;

  const paymentTx = req.nextUrl.searchParams.get("paymentTx") ?? "";
  const result = await verifyX402Forward(paymentTx);

  if (!result.ok) {
    const status =
      result.error === "malformed-tx-id"
        ? 400
        : result.error === "payment-not-found"
          ? 404
          : result.error === "mirror-unreachable"
            ? 502
            : 200;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
