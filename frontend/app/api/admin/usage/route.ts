/**
 * GET /api/admin/usage — founder-only usage telemetry.
 *
 * Returns today's aggregate counts per event, recent anonymous samples,
 * and recent builder preview snapshots. Founder-gated like
 * /api/admin/errors: requires a valid wallet session from a founder
 * wallet. 401 bad/missing session · 403 not a founder.
 */

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { getKvStore } from "@/lib/server/store";
import { createUsageStore, dayKey, USAGE_EVENTS } from "@/lib/server/usage-telemetry";
import { isFounderWallet } from "@/lib/server/client-errors";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const cred = sessionCredentialFrom(req);
  if (!cred) {
    return NextResponse.json({ error: "founder sign-in required" }, { status: 401 });
  }
  let address: string | null = null;
  try {
    const { defaultAuthPort } = await import("@/lib/server/townhall/auth");
    const res = await defaultAuthPort().verifySession(cred);
    if (res.ok) address = res.session.address;
  } catch {
    address = null;
  }
  if (!address || !isFounderWallet(address)) {
    return NextResponse.json({ error: address ? "not a founder" : "founder sign-in required" }, { status: address ? 403 : 401 });
  }

  const store = createUsageStore(getKvStore());
  const today = dayKey();
  try {
    const [counts, previews] = await Promise.all([
      store.getCounts(today),
      store.getPreviews(),
    ]);
    const samples: Record<string, unknown> = {};
    for (const e of ["buddy.message_failed", "builder.publish_failed", "builder.preview"] as const) {
      samples[e] = await store.getSamples(e);
    }
    return NextResponse.json({ counts, previews, samples, day: today, events: USAGE_EVENTS });
  } catch {
    return NextResponse.json({ error: "telemetry unavailable" }, { status: 503 });
  }
}
