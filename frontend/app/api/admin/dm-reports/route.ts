import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { getKvStore } from "@/lib/server/store";
import { defaultClientErrorAdminDeps, isFounderWallet } from "@/lib/server/client-errors";
import { listDmReports } from "@/lib/server/dms";

export const runtime = "nodejs";

/**
 * GET /api/admin/dm-reports
 *
 * Founder-only list of DM abuse reports (newest first). Reports are filed
 * by users from the Messages page and stored off-chain in KV.
 *
 * 401 bad/missing session · 403 not a founder · 200 { reports }.
 */
export async function GET(req: NextRequest) {
  const cred = sessionCredentialFrom(req);
  if (cred == null)
    return NextResponse.json({ error: "sign in with your wallet to view DM reports" }, { status: 401 });

  const deps = defaultClientErrorAdminDeps();
  const verified = await deps.verifySession(cred);
  if (!verified.ok) return NextResponse.json({ error: verified.error }, { status: 401 });
  if (!isFounderWallet(verified.address, process.env))
    return NextResponse.json({ error: "DM reports are private — founders only" }, { status: 403 });

  try {
    const reports = await listDmReports(getKvStore());
    return NextResponse.json({ reports });
  } catch {
    return NextResponse.json(
      { error: "could not read DM reports — try again in a moment" },
      { status: 503 },
    );
  }
}
