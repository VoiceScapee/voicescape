/**
 * GET /api/claim-packages/[id]/status — agent-pollable package status.
 *
 * Lets the AGENT learn what happened to its claim package without the
 * human relaying it: pending → finalized → completed, or race_lost /
 * expired. A 404 here means the id never existed; a well-formed id with
 * no status record and no live package means it expired silently after
 * the 24h TTL (reported as expired so the agent stops guessing).
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getClaimPackage } from "@/lib/server/claim-packages";
import { getPackageStatus } from "@/lib/server/package-status";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const recorded = await getPackageStatus("claim", id);
  if (recorded) {
    return NextResponse.json({
      package_id: recorded.packageId,
      status: recorded.status,
      updated_at: new Date(recorded.updatedAt).toISOString(),
      ...(recorded.detail ? { detail: recorded.detail } : {}),
      ...(recorded.transactionId ? { transaction_id: recorded.transactionId } : {}),
      ...(recorded.username ? { username: recorded.username } : {}),
    });
  }
  // No terminal record: is the package still alive (pending) or gone?
  const pkg = await getClaimPackage(id);
  if (pkg) {
    return NextResponse.json({
      package_id: id,
      status: "pending",
      updated_at: new Date(pkg.createdAt).toISOString(),
      detail: "waiting for the human to open the approval link and tap approve",
    });
  }
  if (!/^[0-9a-f]{32}$/.test(id)) {
    return NextResponse.json({ error: "unknown package id" }, { status: 404 });
  }
  return NextResponse.json({
    package_id: id,
    status: "expired",
    detail:
      "this approval link expired without being used (24h TTL) — ask your agent for a fresh one if the human still wants to proceed",
  });
}
