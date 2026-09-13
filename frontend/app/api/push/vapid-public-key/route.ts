import { NextRequest, NextResponse } from "next/server";
import { getKvStore } from "@/lib/server/store";
import { ipGate } from "@/lib/server/rate-limit";
import { ensureVapidKeypair } from "@/lib/server/push";

export const runtime = "nodejs";

/**
 * GET /api/push/vapid-public-key — the VAPID *public* key for push
 * subscription (URL-safe base64, 87 chars).
 *
 * The keypair is self-generated on first use and persisted in KV, so this
 * endpoint always has a key to return — no operator setup. Only the public
 * half is ever served here; the private key never leaves the server.
 *
 * The blockpage toggle fetches this at subscribe time. (A fallback public
 * key lives in client code for the rare case this endpoint is unreachable;
 * it is only a fallback because a rotated keypair would make it stale.)
 *
 * Response: { publicKey: string }.
 */
export async function GET(req: NextRequest) {
  const gated = await ipGate(
    req,
    "push-pubkey",
    "IP_RATE_LIMIT_PUSH_PUBKEY",
    120,
    "too many requests — try again later",
  );
  if (gated) return gated;

  try {
    const { publicKey } = await ensureVapidKeypair(getKvStore());
    return NextResponse.json({ publicKey });
  } catch (e) {
    console.error(
      `[push/vapid-public-key] unavailable: ${e instanceof Error ? e.message : String(e)}`,
    );
    return NextResponse.json(
      { error: "temporarily unavailable — please retry in a moment" },
      { status: 503 },
    );
  }
}
