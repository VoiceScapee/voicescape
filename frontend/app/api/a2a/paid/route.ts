import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { claimPayment, type ClaimError } from "@/lib/server/a2a-paid/verify";

/**
 * POST /api/a2a/paid — Phase 5 paid endpoint prototype (TESTNET ONLY).
 *
 * Body: { orderId, txId }
 * Verifies the payment against the TESTNET mirror node and, only when every
 * check holds, marks the order paid exactly once and returns the entitlement.
 */
export const runtime = "nodejs";

function statusFor(err: ClaimError): number {
  switch (err.code) {
    case "order_not_found":
      return 404;
    case "order_not_payable":
    case "already_claimed":
      return 409;
    case "order_expired":
      return 410;
    case "tx_failed":
    case "wrong_contract":
    case "memo_mismatch":
    case "wrong_function":
    case "underpaid":
      return 422;
    case "verification_timeout":
      return 504;
    case "misconfigured":
      return 503;
  }
}

export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "a2a-paid",
    "IP_RATE_LIMIT_A2A_PAID",
    60,
    "too many payment claims from this network — try again later",
  );
  if (gated) return gated;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const result = await claimPayment({
    orderId: (body as { orderId?: string })?.orderId ?? "",
    txId: (body as { txId?: string })?.txId ?? "",
  });

  if (result.ok) {
    return NextResponse.json({ entitlement: result.entitlement }, { status: 200 });
  }
  const err = result.error;
  const bodyOut =
    err.code === "misconfigured"
      ? { error: "temporarily unavailable — please try again later" }
      : { error: err.code, ...(err.detail ? { detail: err.detail } : {}) };
  return NextResponse.json(bodyOut, { status: statusFor(err) });
}
