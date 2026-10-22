/**
 * POST /api/evm/verify-tip — server-side proof that an EVM-wallet tip landed.
 *
 * The tip UI polls this route after an EVM wallet submits tipPage: the
 * wallet's relay receipt is only a hint, and this mirror-node TipSent
 * check is what turns "submitted" into "confirmed" in the UI. Nothing is
 * credited, stored, or paid out here — it is a read over public logs.
 *
 * Body: { from, to, grossTinybar, sinceTimestamp? }
 *   - from/to: 0x… EVM addresses (tipper, page owner).
 *   - grossTinybar: decimal string of the intended msg.value in tinybar.
 *   - sinceTimestamp: optional mirror-node timestamp lower bound
 *     ("<seconds>.<nanos>"); the UI passes submission time minus a buffer
 *     so client clock skew cannot exclude the log.
 * Responses (always 200 except bad input):
 *   - { verified: true, matched: { from, to, grossTinybar, feeTinybar, timestamp } }
 *   - { verified: false, reason: "no-matching-log" | "mirror-unreachable" | "mirror-malformed" }
 *   - 400 { verified: false, reason: "bad-input" } for malformed bodies.
 * "Not yet verified" is a normal polling state, not an error — the UI
 * keeps polling for ~2 minutes, then leaves the tip in its submitted
 * state with a HashScan link.
 */

import { NextResponse } from "next/server";
import { verifyTipSent } from "@/lib/server/evm-verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tips contract, Hedera mainnet — same id as MAINNET_TIPS_ID in lib/contracts.ts. */
const TIPS_CONTRACT_ID = "0.0.10854060";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DIGITS_RE = /^\d+$/;
const TIMESTAMP_RE = /^\d+\.\d+$/;

interface VerifyTipBody {
  from?: unknown;
  to?: unknown;
  grossTinybar?: unknown;
  sinceTimestamp?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: VerifyTipBody;
  try {
    body = (await request.json()) as VerifyTipBody;
  } catch {
    return NextResponse.json({ verified: false, reason: "bad-input" }, { status: 400 });
  }
  const from = typeof body.from === "string" ? body.from : "";
  const to = typeof body.to === "string" ? body.to : "";
  const gross = typeof body.grossTinybar === "string" ? body.grossTinybar : "";
  const since = body.sinceTimestamp;
  if (
    !ADDRESS_RE.test(from) ||
    !ADDRESS_RE.test(to) ||
    !DIGITS_RE.test(gross) ||
    (since !== undefined && (typeof since !== "string" || !TIMESTAMP_RE.test(since)))
  ) {
    return NextResponse.json({ verified: false, reason: "bad-input" }, { status: 400 });
  }
  const result = await verifyTipSent({
    contractId: TIPS_CONTRACT_ID,
    expected: { from, to, grossTinybar: gross },
    sinceTimestamp: typeof since === "string" ? since : undefined,
  });
  if (!result.ok) {
    return NextResponse.json({ verified: false, reason: result.reason });
  }
  const matched = result.matched;
  return NextResponse.json({
    verified: true,
    matched: matched
      ? {
          from: matched.from,
          to: matched.to,
          grossTinybar: matched.grossTinybar.toString(),
          feeTinybar: matched.feeTinybar.toString(),
          timestamp: matched.timestamp,
        }
      : null,
  });
}
