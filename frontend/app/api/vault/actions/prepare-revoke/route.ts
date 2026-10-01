/**
 * POST /api/vault/actions/prepare-revoke — build the UNSIGNED revocation.
 *
 * Body: { vault_account_id: "0.0.x", human_account_id: "0.0.x" }.
 * The vault must be watched under that human; the human's key is re-read
 * from the mirror node. The output sets the vault key to the human's key
 * ONLY — after it lands, the agent's key is cryptographically dead.
 *
 * Safe by construction: this transaction can only REMOVE the agent, and
 * only the human's wallet can sign it (threshold-1 includes the human).
 * Rate-limited per IP. Never touches keys; never signs.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getVaultWatch } from "@/lib/server/vault-monitor";
import { humanKeyFromMirrorAccount, keyFingerprint } from "@/lib/server/vault-keys";
import { buildVaultRevokeTx } from "@/lib/server/vault-tx";
import { ipGate } from "@/lib/server/rate-limit";

const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";
const ID_RE = /^0\.0\.\d+$/;

export async function POST(req: Request): Promise<Response> {
  const gated = await ipGate(req, "vault-revoke", "VAULT_REVOKE_IP_LIMIT", 20, "too many revocation attempts — try again in a bit");
  if (gated) return gated;

  let vaultAccountId = "";
  let humanAccountId = "";
  try {
    const body = (await req.json()) as { vault_account_id?: unknown; human_account_id?: unknown };
    vaultAccountId = typeof body.vault_account_id === "string" ? body.vault_account_id.trim() : "";
    humanAccountId = typeof body.human_account_id === "string" ? body.human_account_id.trim() : "";
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (!ID_RE.test(vaultAccountId) || !ID_RE.test(humanAccountId)) {
    return NextResponse.json({ error: "vault_account_id and human_account_id must be 0.0.x accounts" }, { status: 400 });
  }

  const watch = await getVaultWatch(vaultAccountId);
  if (!watch || watch.humanAccountId !== humanAccountId) {
    return NextResponse.json(
      { error: "this vault isn't registered under that account — only the vault's human owner can revoke" },
      { status: 403 },
    );
  }

  let humanKey;
  try {
    const res = await fetch(`${MIRROR_BASE}/accounts/${humanAccountId}`, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      return NextResponse.json({ error: `account ${humanAccountId} not found on Hedera mainnet` }, { status: 400 });
    }
    const parsed = humanKeyFromMirrorAccount(await res.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ error: `can't revoke from this account: ${parsed.error}`, guidance: parsed.guidance }, { status: 400 });
    }
    humanKey = parsed;
  } catch {
    return NextResponse.json({ error: "mirror node unreachable — try again in a moment" }, { status: 502 });
  }

  let built;
  try {
    built = buildVaultRevokeTx({
      vaultAccountId,
      humanKey: humanKey.publicKey,
      payerAccountId: humanAccountId,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "couldn't build the revocation" }, { status: 500 });
  }

  return NextResponse.json({
    unsigned_tx_bytes: built.unsignedTxBytes,
    transaction_id: built.transactionId,
    tx_type: built.txType,
    vault_account_id: vaultAccountId,
    human_key_fingerprint: keyFingerprint(humanKey.keyHex),
    what_youre_signing:
      `ONE signature removes your agent's access to this spending account — the account goes back ` +
      `to your key only. After it confirms, @${watch.agentUsername ?? "the agent"} can't touch the account ` +
      `any more; anything it tries next simply fails. Your funds stay in the account until you sweep them. ` +
      `Costs a few cents of gas.`,
  });
}
