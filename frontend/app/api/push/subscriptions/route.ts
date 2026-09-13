import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { getKvStore } from "@/lib/server/store";
import { ipGate } from "@/lib/server/rate-limit";
import {
  addSubscription,
  removeSubscription,
  validateSubscriptionPayload,
} from "@/lib/server/push";

export const runtime = "nodejs";

/**
 * POST /api/push/subscriptions — register a web-push subscription so this
 * device gets notified when the signed-in wallet receives a tip.
 *
 * Session-checked (the credential travels in the x-vs-session header).
 * Body: { endpoint: string, keys: { p256dh: string, auth: string }, lang?: string }
 *
 * Stores per-wallet in KV (`push:subs:<wallet>`), deduped by endpoint, TTL
 * refreshed (1 year) on every write.
 */
export async function POST(req: NextRequest) {
  const gated = await ipGate(req, "push-subs", "IP_RATE_LIMIT_PUSH_SUBS", 60, "too many requests — try again later");
  if (gated) return gated;

  const verified = await defaultAuthPort().verifySession(sessionCredentialFrom(req));
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  const wallet = verified.session.address.toLowerCase();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validated = validateSubscriptionPayload(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  try {
    const count = await addSubscription(getKvStore(), wallet, validated.sub);
    return NextResponse.json({ ok: true, count });
  } catch (e) {
    console.error(`[push/subscriptions] store failed: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "temporarily unavailable — please retry in a moment" }, { status: 503 });
  }
}

/**
 * DELETE /api/push/subscriptions — remove one endpoint from the signed-in
 * wallet's push subscriptions. Body: { endpoint: string }.
 */
export async function DELETE(req: NextRequest) {
  const gated = await ipGate(req, "push-subs", "IP_RATE_LIMIT_PUSH_SUBS", 60, "too many requests — try again later");
  if (gated) return gated;

  const verified = await defaultAuthPort().verifySession(sessionCredentialFrom(req));
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  const wallet = verified.session.address.toLowerCase();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const endpoint =
    body && typeof body === "object" && typeof (body as { endpoint?: unknown }).endpoint === "string"
      ? (body as { endpoint: string }).endpoint
      : "";
  if (!endpoint) {
    return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
  }

  try {
    const count = await removeSubscription(getKvStore(), wallet, endpoint);
    return NextResponse.json({ ok: true, count });
  } catch (e) {
    console.error(`[push/subscriptions] store failed: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "temporarily unavailable — please retry in a moment" }, { status: 503 });
  }
}
