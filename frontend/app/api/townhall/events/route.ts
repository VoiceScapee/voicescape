import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import {
  createEvent,
  defaultDeps,
  getEvents,
  type CreateEventBody,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/** GET /api/townhall/events → {events:[{id,title,description,startsAt,room}]} */
export async function GET() {
  const { status, json } = await getEvents(defaultDeps());
  return NextResponse.json(json, { status });
}

/**
 * POST /api/townhall/events {author,title,description,startsAt}
 * Author must be a Town Hall moderator — a TOWNHALL_MODS username or a
 * TOWNHALL_MOD_WALLETS wallet (403 otherwise). 201 → {id}; room = "event-<id>".
 */
export async function POST(req: NextRequest) {
  // Per-IP flood bound in front of the per-wallet quotas and dust fees.
  const gated = await ipGate(
    req,
    "townhall",
    "IP_RATE_LIMIT_TOWNHALL",
    300,
    "too many town hall writes from this network — try again later",
  );
  if (gated) return gated;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { status, json } = await createEvent(defaultDeps(), withAuth((body ?? {}) as CreateEventBody, req));
  return NextResponse.json(json, { status });
}
