import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { isFounderWallet } from "@/lib/server/client-errors";
import { setWorkshopStatus, type WorkshopStatus } from "@/lib/server/agent-workshop";

export const runtime = "nodejs";

/**
 * POST /api/workshop/reports/[id]/status {status}
 * Founder-only triage: moves a report along new → confirmed → fixing →
 * shipped. There is deliberately NO auto-transition anywhere — every
 * status change is a human decision, and fixes ship on the strategic
 * deploy calendar, not from this endpoint.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cred = sessionCredentialFrom(req);
  if (!cred) {
    return NextResponse.json({ error: "Sign in with your wallet." }, { status: 401 });
  }
  const verified = await defaultAuthPort().verifySession(cred);
  if (!verified.ok) return NextResponse.json({ error: verified.error }, { status: 401 });
  if (!isFounderWallet(verified.session.address, process.env)) {
    return NextResponse.json({ error: "Triage is founder-only." }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const status = (body as { status?: unknown })?.status as WorkshopStatus;
  const res = await setWorkshopStatus(id, status);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ report: res.report });
}
