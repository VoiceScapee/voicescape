import { NextRequest, NextResponse } from "next/server";
import { getKvStore } from "@/lib/server/store";
import {
  PUSH_CHECK_SECRET_KV_KEY,
  PUSH_VAPID_KV_KEY,
  runPushCheck,
} from "@/lib/server/push";
import { PUSH_VAPID_PUBLIC_KEY } from "@/lib/push";
import { resolveUsernameForOwner } from "@/lib/registry-reverse";
import { siteUrl } from "@/lib/seo";

export const runtime = "nodejs";

/**
 * POST /api/push/check — server-to-server sweep for new tips.
 *
 * Triggered externally (e.g. a cron job) — NOT by browsers. The caller must
 * send the shared secret in the `x-push-secret` header. The secret lives in
 * the KV store at key "push:check:secret" and is set by the operator with
 * any random string, e.g.:
 *
 *   node -e '...'  (or scripts/store-vapid-key.mjs style)
 *   await getKvStore().set("push:check:secret", "<random-secret>", <ttlMs>)
 *
 * Flow: fetch recent TipSent logs from the official Hedera mirror node for
 * the Tips contract (0.0.10854060) → for each log newer than the watermark
 * (KV "push:check:lastTs") → exactly-once delivery via setNx on
 * "push:sent:<txhash>" → web-push to the recipient's subscribed devices
 * → dead subscriptions (410/404) are pruned → watermark advances.
 *
 * The VAPID private key comes from KV "push:vapid:private" (never code/git).
 * When it is absent the sweep honestly skips sends but still advances the
 * watermark, reporting { skipped: "no-vapid-key" }.
 *
 * Response: { checked, sent, pruned, skipped? }.
 */
export async function POST(req: NextRequest) {
  const kv = getKvStore();
  let expectedSecret: string | null = null;
  let vapidPrivateKey: string | null = null;
  try {
    expectedSecret = await kv.get(PUSH_CHECK_SECRET_KV_KEY);
    vapidPrivateKey = await kv.get(PUSH_VAPID_KV_KEY);
  } catch (e) {
    console.error(`[push/check] KV unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json(
      { error: "temporarily unavailable — please retry in a moment" },
      { status: 503 },
    );
  }

  const result = await runPushCheck({
    kv,
    vapidPublicKey: PUSH_VAPID_PUBLIC_KEY,
    vapidPrivateKey,
    expectedSecret,
    providedSecret: req.headers.get("x-push-secret"),
    siteUrl: siteUrl(),
    resolveUsername: resolveUsernameForOwner,
  });

  return NextResponse.json(result.body, { status: result.status });
}
