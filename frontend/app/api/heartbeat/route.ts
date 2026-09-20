import { NextRequest, NextResponse } from "next/server";
import { fetchHeartbeat } from "@/lib/server/heartbeat";
import { ipGate } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

/**
 * GET /api/heartbeat?wallet=<0.0.x | 0x…>
 *
 * The Blockchain Heartbeat's server endpoint (builder module #14). The
 * browser NEVER queries the mirror node directly — it polls here (~10s
 * while the heartbeat is visible), and this route reads the Tips
 * contract's TipSent logs from the official Hedera mirror node.
 *
 * 200 → { ok, status: "ok"|"degraded"|"offline", wallet, cursor,
 *          checkedAt, cached, slow, events: [{ id, type: "tip",
 *          amountHbar, amountTinybar, ts, txHash }] }
 * 400 → { error } for a malformed wallet.
 * 429 → per-IP flood bound. 503 → never (transport failures degrade).
 *
 * Read-only public data. No keys, no HBAR movement.
 */
export async function GET(req: NextRequest) {
  // Heartbeat polls are cheap but unattended: bound per-IP floods in front
  // of the mirror node. 120/min leaves wide headroom for ~10s polling.
  const gated = await ipGate(
    req,
    "heartbeat",
    "IP_RATE_LIMIT_HEARTBEAT",
    120,
    "too many heartbeat requests from this network — try again in a moment",
  );
  if (gated) return gated;

  const wallet = req.nextUrl.searchParams.get("wallet") ?? "";
  const result = await fetchHeartbeat(wallet);
  if (!result.ok && result.error === "bad-wallet") {
    return NextResponse.json(
      { error: "wallet must be a Hedera account id (0.0.x) or EVM address (0x…)" },
      { status: 400 },
    );
  }
  return NextResponse.json(result);
}
