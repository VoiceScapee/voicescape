/**
 * GET /api/vault-packages/[id]/status — agent-pollable vault package status.
 *
 * Same contract as the claim-package status endpoint: pending →
 * finalized → completed, or race_lost / expired. Lets the agent learn
 * whether the human tapped the vault setup link without asking the human.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getVaultPackage } from "@/lib/server/vault-packages";
import { getPackageStatus } from "@/lib/server/package-status";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const recorded = await getPackageStatus("vault", id);
  if (recorded) {
    return NextResponse.json({
      package_id: recorded.packageId,
      status: recorded.status,
      updated_at: new Date(recorded.updatedAt).toISOString(),
      ...(recorded.detail ? { detail: recorded.detail } : {}),
      ...(recorded.transactionId ? { transaction_id: recorded.transactionId } : {}),
      ...(recorded.vaultAccountId ? { vault_account_id: recorded.vaultAccountId } : {}),
    });
  }
  const pkg = await getVaultPackage(id);
  if (pkg) {
    return NextResponse.json({
      package_id: id,
      status: "pending",
      updated_at: new Date(pkg.createdAt).toISOString(),
      detail: "waiting for the human to open the vault setup link and tap approve",
    });
  }
  if (!/^[0-9a-f]{32}$/.test(id)) {
    return NextResponse.json({ error: "unknown package id" }, { status: 404 });
  }
  return NextResponse.json({
    package_id: id,
    status: "expired",
    detail:
      "this setup link expired without being used (24h TTL) — prepare a fresh one if the human still wants to proceed",
  });
}
