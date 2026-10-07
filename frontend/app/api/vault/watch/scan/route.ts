import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import { getAllWatchedVaultIds, scanVault } from "@/lib/server/vault-monitor";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/vault/watch/scan — scheduled vault health scan.
 *
 * Iterates every watched vault and runs scanVault (key-integrity check,
 * activity scan, balance floor). Alerts are recorded on the watch records,
 * surfaced via check_vault_health and /v/manage.
 *
 * Triggered by Vercel Cron — vercel.json is the single source of truth for the
 * cadence (currently daily); do not restate the schedule here or it will drift
 * again (see the webhooks/poll "every 5 minutes" incident). Guarded by CRON_SECRET:
 * fails closed with 503 when the secret is unset and 401 when the Bearer
 * token is missing or wrong. Same pattern as /api/webhooks/poll.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const gated = await ipGate(
    req,
    "vault-watch-scan",
    "IP_RATE_LIMIT_VAULT_SCAN",
    60,
    "too many scan requests — slow down",
  );
  if (gated) return gated;

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "vault scan not configured" }, { status: 503 });
  }
  const bearer = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const a = Buffer.from(bearer, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const vaultIds = await getAllWatchedVaultIds();
    let scanned = 0;
    let alerted = 0;
    const errors: string[] = [];
    for (const vaultId of vaultIds) {
      try {
        const { alerts } = await scanVault(vaultId);
        scanned++;
        if (alerts.length > 0) alerted++;
      } catch (e) {
        errors.push(`${vaultId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return NextResponse.json({
      scanned,
      alerted,
      vaults: vaultIds.length,
      errors: errors.slice(0, 10),
    });
  } catch (e) {
    console.error(`[vault-watch] scan failed: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "scan failed — will retry on next tick" }, { status: 502 });
  }
}
