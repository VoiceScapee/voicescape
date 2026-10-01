import { NextRequest, NextResponse } from "next/server";
import { getKvStore } from "@/lib/server/store";
import { ipGate } from "@/lib/server/rate-limit";
import { defaultHcsPort } from "@/lib/server/townhall/hcs";
import { defaultRegistryPort } from "@/lib/server/townhall/registry-check";
import { resolveUsernameForOwner } from "@/lib/registry-reverse";
import { siteUrl } from "@/lib/seo";
import {
  PUSH_CHECK_SECRET_KV_KEY,
} from "@/lib/server/push";
import {
  runSocialSweep,
  secretsMatch,
} from "@/lib/server/notify";

export const runtime = "nodejs";

/**
 * POST /api/notify/check — sweep for human return-loop events and
 * push-notify opted-in devices.
 *
 * Detects (read-only, all via the official Hedera mirror node):
 *   - replies to your forum posts (and posts on your wall)
 *   - @mentions of your username in forum posts and chat
 *   - new followers of your page
 *   - marketplace sales where you are the seller (PurchaseCompleted logs
 *     on the real mainnet Tips contract — the notification IS the on-chain
 *     proof of the atomic 98/2 settlement)
 *
 * Triggered externally (e.g. a cron job) — NOT by browsers. Auth mirrors
 * /api/push/check: when KV holds "push:check:secret" the x-push-secret
 * header is required; otherwise per-IP rate limiting (20/hour) applies.
 * That fallback is safe by design: a sweep only sends factual
 * notifications derived from real on-chain/HCS data, and per-event setNx
 * idempotency makes repeat calls no-ops.
 *
 * Detected events are also written to each wallet's KV inbox so the
 * notification bell and the /api/digest "while you were away" endpoint
 * show them even when no push subscription exists (push stays opt-in).
 *
 * Response: { checked, events, sent, pruned, skipped? }.
 */
export async function POST(req: NextRequest) {
  const kv = getKvStore();
  let expectedSecret: string | null = null;
  try {
    expectedSecret = await kv.get(PUSH_CHECK_SECRET_KV_KEY);
  } catch (e) {
    console.error(`[notify/check] KV unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json(
      { error: "temporarily unavailable — please retry in a moment" },
      { status: 503 },
    );
  }

  if (expectedSecret == null) {
    const gated = await ipGate(
      req,
      "notify-check",
      "IP_RATE_LIMIT_NOTIFY_CHECK",
      20,
      "too many requests — try again later",
    );
    if (gated) return gated;
  } else if (!secretsMatch(expectedSecret, req.headers.get("x-push-secret"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await runSocialSweep({
    kv,
    hcs: defaultHcsPort(),
    registry: defaultRegistryPort(),
    sendPush: true,
    siteUrl: siteUrl(),
    resolveUsername: resolveUsernameForOwner,
  });

  return NextResponse.json(result.body, { status: result.status });
}
