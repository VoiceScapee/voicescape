import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { isFounderWallet } from "@/lib/server/client-errors";
import { listWorkshopReports, bulkShipNewReports } from "@/lib/server/agent-workshop";

export const runtime = "nodejs";

/**
 * GET /api/workshop/reports/bulk-status
 * Public: how many reports are sitting in "new". Plus whether the caller
 * may bulk-ship them (founder wallet session). Never 401s: anonymous
 * callers get canTriage:false.
 */
export async function GET(req: NextRequest) {
  const fresh = await listWorkshopReports({ status: "new", limit: 100 });
  let canTriage = false;
  const cred = sessionCredentialFrom(req);
  if (cred) {
    const verified = await defaultAuthPort().verifySession(cred);
    if (verified.ok && isFounderWallet(verified.session.address, process.env)) {
      canTriage = true;
    }
  }
  return NextResponse.json({ newCount: fresh.length, canTriage });
}

/**
 * POST /api/workshop/reports/bulk-status
 * Founder-only one-tap triage: moves EVERY report currently in "new"
 * straight to "shipped". Each report goes through the same
 * setWorkshopStatus path as the per-report control (timeline event,
 * reporter credit, shipped compaction, signature-slot release) — this
 * endpoint is just the loop. Irreversible by design: shipped is terminal.
 */
export async function POST(req: NextRequest) {
  const cred = sessionCredentialFrom(req);
  if (!cred) {
    return NextResponse.json({ error: "Sign in with your wallet." }, { status: 401 });
  }
  const verified = await defaultAuthPort().verifySession(cred);
  if (!verified.ok) return NextResponse.json({ error: verified.error }, { status: 401 });
  if (!isFounderWallet(verified.session.address, process.env)) {
    return NextResponse.json({ error: "Triage is founder-only." }, { status: 403 });
  }
  const { shipped, failed } = await bulkShipNewReports();
  return NextResponse.json({ shipped: shipped.length, ids: shipped, failed });
}
