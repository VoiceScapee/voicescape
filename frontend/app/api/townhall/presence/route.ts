import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import {
  getPresenceCount,
  isValidPresenceId,
  isValidPresenceScope,
  pingPresence,
} from "@/lib/server/presence";

export const runtime = "nodejs";

/**
 * GET /api/townhall/presence?scope=<scope> → {scope, count}
 * Approximate headcount for a scope (`chat:lobby`, `forum:general`, …).
 * Fail-open: presence must never break a page.
 */
export async function GET(req: NextRequest) {
  const scope = new URL(req.url).searchParams.get("scope") ?? "";
  if (!isValidPresenceScope(scope)) {
    return NextResponse.json({ error: "invalid scope" }, { status: 400 });
  }
  const count = await getPresenceCount(scope).catch(() => 0);
  return NextResponse.json({ scope, count });
}

/**
 * POST /api/townhall/presence {scope, id} → {scope, count}
 * Heartbeat — call every ~30s while the tab is visible. Entries expire
 * after 60s, so closed tabs fade out on their own. Per-IP flood bound;
 * `id` is `user:<name>` when signed in, otherwise a random tab id.
 */
export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "presence",
    "IP_RATE_LIMIT_PRESENCE",
    600,
    "too many presence pings from this network — try again later",
  );
  if (gated) return gated;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const scope = (body as { scope?: unknown } | null)?.scope;
  const id = (body as { id?: unknown } | null)?.id;
  if (!isValidPresenceScope(scope) || !isValidPresenceId(id)) {
    return NextResponse.json({ error: "scope and id are required" }, { status: 400 });
  }
  const count = await pingPresence(scope, id).catch(() => 0);
  return NextResponse.json({ scope, count });
}
