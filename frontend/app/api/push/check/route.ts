import { NextRequest, NextResponse } from "next/server";
import { getKvStore } from "@/lib/server/store";
import { ipGate } from "@/lib/server/rate-limit";
import {
  PUSH_CHECK_SECRET_KV_KEY,
  runPushCheck,
} from "@/lib/server/push";
import { resolveUsernameForOwner } from "@/lib/registry-reverse";
import { siteUrl } from "@/lib/seo";

export const runtime = "nodejs";

/**
 * POST /api/push/check — sweep for new tips and push-notify recipients.
 *
 * Triggered externally (e.g. a cron job) — NOT by browsers.
 *
 * Auth: the shared secret is OPTIONAL. When KV holds "push:check:secret",
 * the caller must send it in the `x-push-secret` header (401 otherwise).
 * When no secret is configured, the endpoint accepts the call under a
 * per-IP rate limit (20/hour, "push-check" bucket) instead. That fallback
 * is safe by design: a sweep only sends factual notifications derived from
 * real on-chain TipSent logs, and the KV watermark makes repeat calls
 * no-ops — an unauthenticated caller can only trigger the same legitimate
 * sweep the cron would run anyway.
 *
 * NOTE (2026-09-13): the secret is INTENTIONALLY left unset until the
 * shared KV (Upstash) is configured. Production currently runs on the
 * per-instance in-memory store, so a secret set on one instance would
 * not exist on others — cold instances would randomly 401 the sweep
 * while warm ones accept it. Once Upstash is live, one KV write flips
 * this endpoint to the stricter posture; the push-tip-sweep cron doc
 * already says it must then send `x-push-secret`.
 *
 *   await getKvStore().set("push:check:secret", "<random-secret>", <ttlMs>)
 *
 * Flow: fetch recent TipSent logs from the official Hedera mirror node for
 * the Tips contract (0.0.10854060) → for each log newer than the watermark
 * (KV "push:check:lastTs") → exactly-once delivery via setNx on
 * "push:sent:<txhash>" → web-push to the recipient's subscribed devices
 * → dead subscriptions (410/404) are pruned → watermark advances.
 *
 * The VAPID keypair is self-generated on first use and persisted in KV —
 * no operator key setup is required.
 *
 * Response: { checked, sent, pruned, skipped? }.
 */
export async function POST(req: NextRequest) {
  const kv = getKvStore();
  let expectedSecret: string | null = null;
  try {
    expectedSecret = await kv.get(PUSH_CHECK_SECRET_KV_KEY);
  } catch (e) {
    console.error(`[push/check] KV unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json(
      { error: "temporarily unavailable — please retry in a moment" },
      { status: 503 },
    );
  }

  // No secret configured → rate-limit the open endpoint instead of
  // requiring a header nobody can know.
  if (expectedSecret == null) {
    const gated = await ipGate(
      req,
      "push-check",
      "IP_RATE_LIMIT_PUSH_CHECK",
      20,
      "too many requests — try again later",
    );
    if (gated) return gated;
  }

  const result = await runPushCheck({
    kv,
    expectedSecret,
    providedSecret: req.headers.get("x-push-secret"),
    siteUrl: siteUrl(),
    resolveUsername: resolveUsernameForOwner,
  });

  return NextResponse.json(result.body, { status: result.status });
}
