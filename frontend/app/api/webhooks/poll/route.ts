import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { defaultWebhookDeps, pollAndDispatch } from "@/lib/server/webhooks";

export const runtime = "nodejs";

/**
 * GET /api/webhooks/poll — the dispatcher. Tails the Tips contract's event
 * logs on the Hedera mainnet mirror node since the stored cursor and POSTs
 * new tip/purchase events to matching subscriptions.
 *
 * Triggered by Vercel Cron (see vercel.json — every 5 minutes). Guarded by
 * CRON_SECRET: fails closed with 503 when the secret is unset and 401 when
 * the bearer is missing or wrong.
 *
 * The cursor only advances after a successful mirror-node read, so a failed
 * run (502) retries the same window on the next tick — no event is skipped
 * by a transient outage.
 */
export async function GET(req: NextRequest) {
  const gated = await ipGate(
    req,
    "webhooks-poll",
    "IP_RATE_LIMIT_WEBHOOKS_POLL",
    60,
    "too many webhook poll requests — slow down",
  );
  if (gated) return gated;

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "webhook dispatch not configured" }, { status: 503 });
  }
  const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const a = Buffer.from(bearer, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await pollAndDispatch(defaultWebhookDeps());
    return NextResponse.json(result);
  } catch (e) {
    console.error(`[webhooks] poll failed: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "mirror node unavailable — will retry on next tick" }, { status: 502 });
  }
}
