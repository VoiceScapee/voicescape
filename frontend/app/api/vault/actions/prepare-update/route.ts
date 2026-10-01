/**
 * POST /api/vault/actions/prepare-update — "sign as vault".
 *
 * Body: { vault_account_id: "0.0.x", human_account_id: "0.0.x",
 *         username: "name", ipfs_cid: "Qm..." }.
 *
 * Lets the human update a blockpage their agent's spending account owns,
 * signing with the HUMAN's own key (threshold-1 lets either co-owner act).
 * The vault must be watched under that human (403 otherwise), and the
 * vault must own the username on-chain (verified via lookupBlockpage).
 * The update tx is unsigned with the VAULT as payer — gas comes from the
 * vault's balance. The wallet submits it with the human as signer.
 *
 * Rate-limited per IP. Never touches keys; never signs.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { AccountId } from "@hiero-ledger/sdk";
import { getVaultWatch } from "@/lib/server/vault-monitor";
import { buildVaultUpdatePageTx } from "@/lib/server/vault-tx";
import { lookupBlockpage } from "@/lib/server/mcp-tools";
import { ipGate } from "@/lib/server/rate-limit";

const ID_RE = /^0\.0\.\d+$/;

export async function POST(req: Request): Promise<Response> {
  const gated = await ipGate(req, "vault-update", "VAULT_UPDATE_IP_LIMIT", 30, "too many update attempts — try again in a bit");
  if (gated) return gated;

  let vaultAccountId = "";
  let humanAccountId = "";
  let username = "";
  let ipfsCid = "";
  try {
    const body = (await req.json()) as {
      vault_account_id?: unknown;
      human_account_id?: unknown;
      username?: unknown;
      ipfs_cid?: unknown;
    };
    vaultAccountId = typeof body.vault_account_id === "string" ? body.vault_account_id.trim() : "";
    humanAccountId = typeof body.human_account_id === "string" ? body.human_account_id.trim() : "";
    username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    ipfsCid = typeof body.ipfs_cid === "string" ? body.ipfs_cid.trim() : "";
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (!ID_RE.test(vaultAccountId) || !ID_RE.test(humanAccountId)) {
    return NextResponse.json({ error: "vault_account_id and human_account_id must be 0.0.x accounts" }, { status: 400 });
  }

  // Only the vault's registered human owner can act.
  const watch = await getVaultWatch(vaultAccountId);
  if (!watch || watch.humanAccountId !== humanAccountId) {
    return NextResponse.json(
      { error: "this vault isn't registered under that account — only the vault's human owner can sign for it" },
      { status: 403 },
    );
  }

  // The vault must own the username on-chain.
  let existing;
  try {
    existing = await lookupBlockpage(username);
  } catch {
    return NextResponse.json({ error: "couldn't check the username on-chain — try again in a moment" }, { status: 502 });
  }
  if (!existing.found) {
    return NextResponse.json({ error: `@${username} isn't registered yet — the agent registers it first, then you can update it` }, { status: 400 });
  }
  const vaultEvm = `0x${AccountId.fromString(vaultAccountId).toEvmAddress().toLowerCase()}`;
  if ((existing.owner_evm ?? "").toLowerCase() !== vaultEvm && existing.owner_account !== vaultAccountId) {
    return NextResponse.json(
      { error: `@${username} isn't owned by this vault's spending account — you can only update pages your vault owns` },
      { status: 403 },
    );
  }

  let built;
  try {
    built = buildVaultUpdatePageTx({ vaultAccountId, username, ipfsCid });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "couldn't build the update" },
      { status: 400 },
    );
  }

  return NextResponse.json({
    unsigned_tx_bytes: built.unsignedTxBytes,
    transaction_id: built.transactionId,
    tx_type: built.txType,
    vault_account_id: vaultAccountId,
    username,
    what_youre_signing:
      `ONE signature updates @${username}'s blockpage with new content. ` +
      `You're signing as the spending account's co-owner; gas comes from the account's balance. ` +
      `Costs a few cents.`,
  });
}
