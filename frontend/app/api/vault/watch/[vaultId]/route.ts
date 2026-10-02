/**
 * GET /api/vault/watch/[vaultId] — read-only health for one vault.
 * Backs the `check_vault_health` MCP tool and the /v/manage dashboard.
 * No auth: vault ids are public on-chain; this only reports health.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { checkVaultHealth } from "@/lib/server/vault-monitor";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ vaultId: string }> },
): Promise<Response> {
  const { vaultId } = await params;
  if (!/^0\.0\.\d+$/.test(vaultId)) {
    return NextResponse.json({ error: "expected a 0.0.x vault account id" }, { status: 400 });
  }
  let health;
  try {
    health = await checkVaultHealth(vaultId);
  } catch {
    return NextResponse.json({ error: "vault check unavailable — try again in a moment" }, { status: 502 });
  }
  return NextResponse.json({
    vault_account_id: health.vaultId,
    watched: health.watched,
    status: health.status,
    status_detail: health.statusDetail,
    balance_hbar: health.balanceHbar,
    key_match: health.keyHealth.match,
    key_fingerprint: health.keyHealth.actual
      ? health.keyHealth.actual.map((k) => `${k.hex.slice(0, 8)}…${k.hex.slice(-8)}`)
      : null,
    flags: health.flags,
    guidance: health.guidance,
    last_scan_at: health.lastScanAt,
    hashscan_url: `https://hashscan.io/mainnet/account/${health.vaultId}`,
  });
}
