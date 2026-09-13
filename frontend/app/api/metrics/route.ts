import { NextRequest, NextResponse } from "next/server";
import { checkIpRateLimit, clientIpFromHeaders, ipRateLimitFromEnv } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import { recordConversion } from "@/lib/server/conversion";

export const runtime = "nodejs";

/**
 * POST /api/metrics
 * { event: string }
 *
 * Privacy-safe aggregate conversion telemetry. The event name must be on
 * the allowlist (lib/server/conversion.ts); only a daily counter is
 * incremented — no wallet, IP, user agent, page, or tx id is ever stored.
 * Always answers 200 (fail-open): telemetry must never break the paid
 * action it measures.
 *
 * Rate-limited to 60 events/IP/hour (transient counter only — the IP is
 * never persisted). Over-limit events are silently dropped with 200.
 */
export async function POST(req: NextRequest) {
  // Fail-OPEN rate limit: telemetry must keep flowing when the store is
  // degraded, and must never break the page.
  try {
    const res = await checkIpRateLimit(
      clientIpFromHeaders(req.headers),
      "metrics",
      ipRateLimitFromEnv("IP_RATE_LIMIT_METRICS", 60),
      3_600_000,
    );
    if (!res.allowed) return NextResponse.json({ ok: true });
  } catch {
    /* store unreachable — still accept the event below (best-effort) */
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  const b = (body ?? {}) as { event?: unknown };

  try {
    await recordConversion(getKvStore(), b.event);
  } catch {
    /* telemetry must never break the page */
  }
  return NextResponse.json({ ok: true });
}
