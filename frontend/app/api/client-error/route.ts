import { NextRequest, NextResponse } from "next/server";
import { checkIpRateLimit, clientIpFromHeaders, ipRateLimitFromEnv } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import { recordClientError } from "@/lib/server/client-errors";

export const runtime = "nodejs";

/**
 * POST /api/client-error
 * { message: string, page: string, component?: string }
 *
 * Privacy-first client error telemetry. Stores aggregate counts only —
 * never IPs, user agents, wallet addresses, query strings, or stack
 * traces. Always answers 200 (fail-open): a telemetry hiccup must never
 * break the page, and reporting must keep working even when other
 * infrastructure is degraded.
 *
 * Rate-limited to 10 reports/IP/hour (transient counter only — the IP is
 * never persisted). Over-limit reports are silently dropped with 200.
 */
export async function POST(req: NextRequest) {
  // Fail-OPEN rate limit: unlike ipGate (which fails closed with 503),
  // telemetry must keep flowing when the store is degraded.
  try {
    const res = await checkIpRateLimit(
      clientIpFromHeaders(req.headers),
      "client-error",
      ipRateLimitFromEnv("IP_RATE_LIMIT_CLIENT_ERROR", 10),
      3_600_000,
    );
    if (!res.allowed) return NextResponse.json({ ok: true });
  } catch {
    /* store unreachable — still accept the report below (best-effort) */
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }
  const b = (body ?? {}) as { message?: unknown; page?: unknown; component?: unknown; frame?: unknown };

  try {
    await recordClientError(getKvStore(), b.page, b.message, b.component, b.frame);
  } catch {
    /* telemetry must never break the page */
  }
  return NextResponse.json({ ok: true });
}
