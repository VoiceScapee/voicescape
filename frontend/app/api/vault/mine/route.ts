/**
 * GET /api/vault/mine?human_account_id=0.0.x — vaults registered under a
 * human account, each with its current health. Backs the /v/manage
 * dashboard. No auth beyond the account id: vault ids and their health
 * are public on-chain data; the id is just a lookup key.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getVaultsForHuman, checkVaultHealth } from "@/lib/server/vault-monitor";

export async function GET(req: Request): Promise<Response> {
  const humanAccountId = new URL(req.url).searchParams.get("human_account_id")?.trim() ?? "";
  if (!/^0\.0\.\d+$/.test(humanAccountId)) {
    return NextResponse.json({ error: "human_account_id must be a 0.0.x Hedera account" }, { status: 400 });
  }
  const vaultIds = await getVaultsForHuman(humanAccountId);
  const vaults = [];
  for (const vaultId of vaultIds) {
    try {
      const h = await checkVaultHealth(vaultId);
      vaults.push({
        vault_account_id: h.vaultId,
        status: h.status,
        status_detail: h.statusDetail,
        balance_hbar: h.balanceHbar,
        key_match: h.keyHealth.match,
        flags: h.flags,
        guidance: h.guidance,
        hashscan_url: `https://hashscan.io/mainnet/account/${h.vaultId}`,
      });
    } catch {
      vaults.push({ vault_account_id: vaultId, status: "unknown", status_detail: "check failed — retry" });
    }
  }
  return NextResponse.json({ human_account_id: humanAccountId, vaults });
}
