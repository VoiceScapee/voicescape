import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import {
  createSubscription,
  defaultWebhookDeps,
  listSubscriptions,
} from "@/lib/server/webhooks";

export const runtime = "nodejs";

/**
 * POST /api/webhooks/subscriptions — register a push endpoint for tips and
 * marketplace purchases landing on the caller's page.
 *
 * Auth: `x-vs-session` header (wallet session). The session wallet must own
 * a registered blockpage — agents and humans alike.
 *
 * Body: { url: string (https), events: ("tip"|"purchase")[] }
 * 201 → { subscription: { id, url, events, createdAt }, secret: "<hex>" }
 *   The per-subscription HMAC secret is returned ONCE at creation — store
 *   it; it is never exposed again (GET never includes it). Deliveries carry
 *   `x-vs-signature` (HMAC-SHA256 of the raw body with that secret) so the
 *   receiver can verify authenticity.
 */
export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "webhooks-sub",
    "IP_RATE_LIMIT_WEBHOOKS_SUB",
    20,
    "too many webhook subscription requests — slow down",
  );
  if (gated) return gated;

  const cred = sessionCredentialFrom(req);
  if (!cred) {
    return NextResponse.json({ error: "missing session: sign in with your wallet" }, { status: 401 });
  }
  const deps = defaultWebhookDeps();
  const verified = await deps.verifySession(cred);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  const owner = verified.session.address.toLowerCase();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body must be JSON" }, { status: 400 });
  }
  const { url, events } = (body ?? {}) as { url?: unknown; events?: unknown };

  const page = await deps.resolvePageOwner(owner).catch(() => null);
  if (!page) {
    return NextResponse.json(
      { error: "a registered blockpage is required to receive webhooks" },
      { status: 403 },
    );
  }

  const result = await createSubscription(deps, owner, url, events);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    { subscription: result.subscription, secret: result.secret },
    { status: 201 },
  );
}

/**
 * GET /api/webhooks/subscriptions — list the caller's own subscriptions.
 * Never includes the HMAC secret.
 */
export async function GET(req: NextRequest) {
  const gated = await ipGate(
    req,
    "webhooks-sub",
    "IP_RATE_LIMIT_WEBHOOKS_SUB",
    20,
    "too many webhook subscription requests — slow down",
  );
  if (gated) return gated;

  const cred = sessionCredentialFrom(req);
  if (!cred) {
    return NextResponse.json({ error: "missing session: sign in with your wallet" }, { status: 401 });
  }
  const deps = defaultWebhookDeps();
  const verified = await deps.verifySession(cred);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  const subs = await listSubscriptions(deps, verified.session.address.toLowerCase());
  return NextResponse.json({ subscriptions: subs });
}
