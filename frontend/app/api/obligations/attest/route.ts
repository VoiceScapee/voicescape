import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { ipGate } from "@/lib/server/rate-limit";
import { attestObligation } from "@/lib/server/obligations";

export const runtime = "nodejs";

/**
 * POST /api/obligations/attest — attest an obligation state for a settled payment.
 *
 * Body: { payment_tx_id, state: "fulfilled"|"disputed"|"refunded", note? }
 *
 * Auth: signed wallet session (x-vs-session header). 401 without. The
 * session wallet must be the side of the payment allowed to attest the
 * requested state: the payee for fulfilled/refunded, the payer for disputed.
 * 403 otherwise.
 *
 * The payment is verified against the Hedera mainnet mirror node — it must
 * exist with consensus SUCCESS. Pending or failed transactions are refused.
 * This is the merchant-attested half of a receipt: the chain proves
 * settlement; the attestation says what the payment was for.
 *
 * Rate limits: 60/hour per IP (flood gate) + 20/day per wallet.
 */

export async function POST(req: NextRequest): Promise<NextResponse> {
  const gated = await ipGate(
    req,
    "obligation-attest",
    "IP_RATE_LIMIT_OBLIGATION_ATTEST",
    60,
    "too many attestation requests from this network — try again later",
  );
  if (gated) return gated;

  const cred = sessionCredentialFrom(req);
  if (!cred) {
    return NextResponse.json({ error: "missing session: sign in with your wallet" }, { status: 401 });
  }
  const verified = await defaultAuthPort().verifySession(cred, { allowAgent: true });
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  const wallet = verified.session.address;

  let body: { payment_tx_id?: unknown; state?: unknown; note?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const result = await attestObligation({
    paymentTxId: typeof body.payment_tx_id === "string" ? body.payment_tx_id : "",
    state: body.state as "fulfilled" | "disputed" | "refunded",
    wallet,
    note: typeof body.note === "string" ? body.note : undefined,
  });

  if (!result.ok) {
    const status =
      result.error === "not-a-counterparty"
        ? 403
        : result.error === "rate-limited"
          ? 429
          : result.error === "unavailable"
            ? 503
            : 400;
    return NextResponse.json({ error: result.detail }, { status });
  }
  return NextResponse.json({ obligation: result.record });
}
