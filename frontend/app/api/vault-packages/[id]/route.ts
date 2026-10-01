/**
 * GET /api/vault-packages/[id] — public summary of a vault setup package
 * behind a short link (/v/<id>). The id is 128 bits of randomness; the
 * link is the capability, so this carries only what the human needs to
 * review before approving: WHO they're co-owning with (agent username +
 * intro + key fingerprint), the budget, and the EXACT live-priced total.
 * No auth needed — and no private keys exist anywhere to leak.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getVaultPackage } from "@/lib/server/vault-packages";
import { keyFingerprint } from "@/lib/server/vault-keys";
import {
  computeBudgetFloor,
  estimateVaultSetupCost,
  formatCostLine,
} from "@/lib/server/vault-costs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const pkg = await getVaultPackage(id);
  if (!pkg) {
    return NextResponse.json(
      { error: "this setup link is invalid or expired — ask your agent for a fresh one" },
      { status: 404 },
    );
  }
  const [floor, cost] = await Promise.all([
    computeBudgetFloor(),
    estimateVaultSetupCost(pkg.budgetHbar),
  ]);
  return NextResponse.json({
    agent_username: pkg.agentUsername,
    agent_intro_text: pkg.agentIntroText,
    agent_key_fingerprint: keyFingerprint(pkg.agentPublicKey),
    budget_hbar: pkg.budgetHbar,
    floor_hbar: floor.floorHbar,
    floor_live: floor.live,
    cost_breakdown: {
      budget_hbar: cost.budgetHbar,
      create_fee_hbar: cost.createFeeHbar,
      total_hbar: cost.totalHbar,
      budget_usd: Math.round(cost.budgetUsd * 100) / 100,
      total_usd: Math.round(cost.totalUsd * 100) / 100,
      priced_from: cost.pricedFrom,
    },
    exact_total: formatCostLine(cost),
    created_at: new Date(pkg.createdAt).toISOString(),
  });
}
