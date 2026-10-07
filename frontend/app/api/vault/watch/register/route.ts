/**
 * POST /api/vault/watch/register — watch a vault created outside the
 * setup-link flow (or re-register one).
 *
 * Body: { vault_account_id: "0.0.x", human_account_id: "0.0.x",
 *         agent_public_key?: "64-hex", agent_username?: "handle" }.
 * The human's key is read from the mirror node; the agent key is optional
 * (without it the key check reports "unverified" — honest, not silent).
 * Rate-limited per IP. Never touches keys; never signs.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { registerVaultWatch } from "@/lib/server/vault-monitor";
import { humanKeyFromMirrorAccount, normalizeAgentPublicKey } from "@/lib/server/vault-keys";
import { ipGate } from "@/lib/server/rate-limit";

const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";
const ID_RE = /^0\.0\.\d+$/;

export async function POST(req: Request): Promise<Response> {
  const gated = await ipGate(req, "vault-watch", "VAULT_WATCH_IP_LIMIT", 20, "too many watch registrations — try again in a bit");
  if (gated) return gated;

  let vaultAccountId = "";
  let humanAccountId = "";
  let agentPublicKey: string | null = null;
  let agentUsername: string | null = null;
  try {
    const body = (await req.json()) as {
      vault_account_id?: unknown;
      human_account_id?: unknown;
      agent_public_key?: unknown;
      agent_username?: unknown;
    };
    vaultAccountId = typeof body.vault_account_id === "string" ? body.vault_account_id.trim() : "";
    humanAccountId = typeof body.human_account_id === "string" ? body.human_account_id.trim() : "";
    if (typeof body.agent_public_key === "string" && body.agent_public_key.trim()) {
      const n = normalizeAgentPublicKey(body.agent_public_key);
      if (!n.ok) return NextResponse.json({ error: `agent_public_key: ${n.error}` }, { status: 400 });
      agentPublicKey = n.keyHex;
    }
    if (typeof body.agent_username === "string" && body.agent_username.trim()) {
      const u = body.agent_username.trim().toLowerCase();
      if (!/^[a-z0-9_-]{3,32}$/.test(u)) {
        return NextResponse.json({ error: "agent_username must be 3-32 lowercase letters/numbers/_/-" }, { status: 400 });
      }
      agentUsername = u;
    }
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (!ID_RE.test(vaultAccountId) || !ID_RE.test(humanAccountId)) {
    return NextResponse.json({ error: "vault_account_id and human_account_id must be 0.0.x accounts" }, { status: 400 });
  }

  let humanKey;
  try {
    const res = await fetch(`${MIRROR_BASE}/accounts/${humanAccountId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `account ${humanAccountId} not found on Hedera mainnet` }, { status: 400 });
    }
    const parsed = humanKeyFromMirrorAccount(await res.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ error: `can't watch from this account: ${parsed.error}`, guidance: parsed.guidance }, { status: 400 });
    }
    humanKey = parsed;
  } catch {
    return NextResponse.json(
      { error: "mirror node unreachable — try again in a moment", code: "MIRROR_UNAVAILABLE", retryable: true },
      { status: 502 },
    );
  }

  try {
    await registerVaultWatch({
      vaultId: vaultAccountId,
      humanAccountId,
      humanKeyHex: humanKey.keyHex,
      humanKeyType: humanKey.keyType,
      agentKeyHex: agentPublicKey,
      agentUsername,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "couldn't register the watch" }, { status: 500 });
  }

  return NextResponse.json({
    watched: true,
    vault_account_id: vaultAccountId,
    key_verification: agentPublicKey ? "active — the on-chain key is compared against the registered human+agent pair" : "unverified — no agent key registered, so key changes can't be verified",
    message: `Watching ${vaultAccountId}: key integrity, suspicious activity, and the ~1 HBAR balance floor are checked by the daily watch scan. See /v/manage.`,
  });
}
