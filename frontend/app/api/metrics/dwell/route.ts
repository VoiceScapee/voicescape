import { NextRequest, NextResponse } from "next/server";
import { checkIpRateLimit, clientIpFromHeaders, ipRateLimitFromEnv } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import { openDwellFlow, recordDwellSettled, recordDwellSign } from "@/lib/server/dwell";

export const runtime = "nodejs";

/**
 * POST /api/metrics/dwell
 *
 * Anonymous dwell-time telemetry for the tip flow. Three actions:
 *   { action: "flow_open", context?, cohort? } -> { ok, flowId?, nonce? }
 *     T1 stamped on the server clock; returns a flow id + challenge nonce.
 *   { action: "sign_submit", flowId, nonce } -> { ok }
 *     T2 stamped on the server clock; nonce must match; one sign per flow.
 *   { action: "settled", flowId, nonce, t3 } -> { ok }
 *     t3 = mirror-node consensus timestamp in epoch ms. Runs monotonicity
 *     + bounds checks; violations are flagged in aggregate counters.
 *
 * Privacy: flow records hold bare timestamps, the nonce, a coarse surface
 * label, and an optional client-generated cohort key. Never stored: wallet,
 * IP, user agent, page URL, username, tx id. 7-day TTL.
 *
 * Always answers 200 (fail-open): telemetry must never break the paid
 * action it measures. Rate-limited per IP (transient counter, never
 * persisted); over-limit events are silently dropped with 200.
 */
export async function POST(req: NextRequest) {
  try {
    const res = await checkIpRateLimit(
      clientIpFromHeaders(req.headers),
      "metrics-dwell",
      ipRateLimitFromEnv("IP_RATE_LIMIT_METRICS_DWELL", 60),
      3_600_000,
    );
    if (!res.allowed) return NextResponse.json({ ok: true });
  } catch {
    /* store unreachable — still accept below (best-effort) */
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  const b = (body ?? {}) as {
    action?: unknown;
    context?: unknown;
    cohort?: unknown;
    flowId?: unknown;
    nonce?: unknown;
    t3?: unknown;
  };

  try {
    const store = getKvStore();
    if (b.action === "flow_open") {
      const opened = await openDwellFlow(store, { context: b.context, cohort: b.cohort });
      if (opened) return NextResponse.json({ ok: true, flowId: opened.flowId, nonce: opened.nonce });
      return NextResponse.json({ ok: true });
    }
    if (b.action === "sign_submit") {
      await recordDwellSign(store, b.flowId, b.nonce);
      return NextResponse.json({ ok: true });
    }
    if (b.action === "settled") {
      await recordDwellSettled(store, b.flowId, b.nonce, b.t3);
      return NextResponse.json({ ok: true });
    }
  } catch {
    /* telemetry must never break the page */
  }
  return NextResponse.json({ ok: true });
}
