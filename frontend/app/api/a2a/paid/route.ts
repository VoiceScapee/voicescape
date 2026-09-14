import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { answerMessage } from "@/lib/a2a/handler";
import {
  buildFacilitator,
  buildPaymentRequired,
  decodePaymentSignature,
  encodePaymentRequired,
  encodePaymentResponse,
  findMatchingRequirements,
  getPaidEndpointConfig,
  PaidRequestError,
  paymentResourceMatches,
  verifyAndSettle,
} from "@/lib/a2a/x402-paid";

/**
 * POST /api/a2a/paid — danny's PAID A2A onboarding endpoint (x402).
 *
 * The same Q&A brain as the free POST /api/a2a (lib/a2a/handler.ts), behind
 * a dust-level x402 paywall (default 1¢/request, HBAR or USDC rail):
 *
 *   1. POST without payment  -> 402 + PAYMENT-REQUIRED header (price menu)
 *   2. Buyer signs a partial Hedera transfer (buyer sig only, facilitator
 *      feePayer as payer) and retries with PAYMENT-SIGNATURE
 *   3. Server verifies + settles via the x402 facilitator ("upfront" flow)
 *   4. ONLY after on-chain settlement does the Q&A brain answer
 *   5. 200 + PAYMENT-RESPONSE settle-receipt header
 *
 * Money rules (fail closed — this endpoint handles live money):
 *   - Misconfigured (no facilitator, bad price, bad network) -> 503.
 *     It NEVER 402s for a payment it cannot verify/settle.
 *   - Only SendMessage (and the v0.3 message/send alias) is served, paid.
 *     Other JSON-RPC methods get a plain protocol error — no charge.
 *   - Replay hygiene: payments minted for another resource URL are rejected.
 *   - At dust prices the 2% treasury forward is skipped by the proven skip
 *     rule (share < 2x forward fee): danny keeps 100% of each dust payment.
 *
 * This route is BUILT and GATED but NOT YET LIVE for real money: mainnet
 * settlement needs DANNY_X402_FACILITATOR_URL + DANNY_X402_FEE_PAYER_ACCOUNT
 * (via Secure Vault). Until then it 503s on mainnet by design.
 */
export const runtime = "nodejs";

const SEND_METHODS = new Set(["SendMessage", "message/send"]);

function resourceUrl(req: NextRequest): string {
  return new URL("/api/a2a/paid", req.url).toString();
}

export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "a2a-paid",
    "IP_RATE_LIMIT_A2A_PAID",
    60,
    "too many paid A2A requests from this network — try again later",
  );
  if (gated) return gated;

  // Fail closed: any misconfiguration -> 503, never a 402 we can't settle.
  let config;
  try {
    config = getPaidEndpointConfig();
  } catch (e) {
    return NextResponse.json(
      {
        error:
          "Paid onboarding is unavailable: x402 is not configured. " +
          "No payment was requested or settled.",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 200 },
    );
  }

  const method = (body as { method?: unknown } | null)?.method;
  const id = (body as { id?: unknown } | null)?.id ?? null;

  // Only answers are for sale. Task introspection etc. get a protocol
  // error, never a charge — the free /api/a2a serves those.
  if (typeof method !== "string" || !SEND_METHODS.has(method)) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: typeof id === "string" || typeof id === "number" ? id : null,
        error: {
          code: -32601,
          message:
            "Method not found on the paid endpoint: only SendMessage (message/send) " +
            "is served here — use POST /api/a2a (free) for task queries.",
        },
      },
      { status: 200 },
    );
  }

  const resource = resourceUrl(req);

  // Unpaid -> 402 price menu. This is the x402 handshake, not an error.
  const sigHeader = req.headers.get("PAYMENT-SIGNATURE");
  if (!sigHeader) {
    const doc = buildPaymentRequired(config, resource);
    return new NextResponse(
      JSON.stringify({ error: "Payment required: this is danny's paid onboarding endpoint." }),
      {
        status: 402,
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-REQUIRED": encodePaymentRequired(doc),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  // Paid: verify + settle, then serve. Every failure mode below leaves the
  // buyer uncharged-or-refundable at the facilitator, never silently served.
  try {
    const payload = decodePaymentSignature(sigHeader);
    if (!paymentResourceMatches(payload, resource)) {
      throw new PaidRequestError(
        402,
        "Payment payload resource mismatch — this payment was not minted for /api/a2a/paid.",
      );
    }
    const advertised = buildPaymentRequired(config, resource).accepts;
    const requirements = findMatchingRequirements(payload, advertised);
    if (!requirements) {
      throw new PaidRequestError(
        402,
        "Payment does not match the advertised terms (network/asset/amount/payTo).",
      );
    }
    const receipt = await verifyAndSettle(buildFacilitator(config), payload, requirements);

    const params = ((body as { params?: Record<string, unknown> }).params ?? {}) as Record<
      string,
      unknown
    >;
    const task = answerMessage(params);
    return NextResponse.json(
      { jsonrpc: "2.0", id: typeof id === "string" || typeof id === "number" ? id : null, result: task },
      {
        status: 200,
        headers: { "PAYMENT-RESPONSE": encodePaymentResponse(receipt) },
      },
    );
  } catch (e) {
    if (e instanceof PaidRequestError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: "Paid request failed unexpectedly. No answer was served." },
      { status: 502 },
    );
  }
}

export async function GET() {
  return NextResponse.json(
    {
      error:
        "danny's paid onboarding lives at POST /api/a2a/paid — unpaid POSTs get a 402 price menu (x402). " +
        "The same Q&A is free at POST /api/a2a.",
    },
    { status: 405 },
  );
}
