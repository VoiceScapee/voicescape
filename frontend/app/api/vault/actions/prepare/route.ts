/**
 * POST /api/vault/actions/prepare — pairing-first vault setup.
 *
 * Body: { package_id: "<id>", human_account_id: "0.0.x" } — the wallet
 * the human just paired on the setup page. The server re-reads the
 * human's key from the mirror node (never trusts client key material)
 * and builds the frozen UNSIGNED AccountCreateTransaction with the
 * ACTUALLY CONNECTED account as payer: KeyList([human, agent], 1),
 * initial balance = the package budget.
 *
 * Auth: none beyond the unguessable package id — the output is unsigned
 * bytes; only the named account's wallet can sign them, and the wallet's
 * own confirmation screen is the authorization. Rate-limited per IP.
 * Never touches keys; never signs.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { PublicKey } from "@hiero-ledger/sdk";
import { getVaultPackage } from "@/lib/server/vault-packages";
import { humanKeyFromMirrorAccount, type MirrorAccountKey } from "@/lib/server/vault-keys";
import { buildVaultCreateTx } from "@/lib/server/vault-tx";
import { estimateVaultSetupCost, formatCostLine } from "@/lib/server/vault-costs";
import { ipGate } from "@/lib/server/rate-limit";

const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";

export async function POST(req: Request): Promise<Response> {
  const gated = await ipGate(
    req,
    "vault-prepare",
    "VAULT_PREPARE_IP_LIMIT",
    20,
    "too many vault setup attempts — try again in a bit",
  );
  if (gated) return gated;

  let packageId = "";
  let humanAccountId = "";
  try {
    const body = (await req.json()) as { package_id?: unknown; human_account_id?: unknown };
    packageId = typeof body.package_id === "string" ? body.package_id.trim() : "";
    humanAccountId = typeof body.human_account_id === "string" ? body.human_account_id.trim() : "";
  } catch {
    return NextResponse.json({ error: "body must be JSON with package_id and human_account_id" }, { status: 400 });
  }
  if (!/^[0-9a-f]{32}$/.test(packageId)) {
    return NextResponse.json({ error: "package_id is invalid" }, { status: 400 });
  }
  if (!/^0\.0\.\d+$/.test(humanAccountId)) {
    return NextResponse.json({ error: "human_account_id must be a 0.0.x Hedera account" }, { status: 400 });
  }

  const pkg = await getVaultPackage(packageId);
  if (!pkg) {
    return NextResponse.json(
      { error: "this setup link is invalid or expired — ask your agent for a fresh one" },
      { status: 404 },
    );
  }

  // The human's key — read FRESH from the mirror node, never from the client.
  let humanKey;
  try {
    const res = await fetch(`${MIRROR_BASE}/accounts/${humanAccountId}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `account ${humanAccountId} not found on Hedera mainnet` },
        { status: 400 },
      );
    }
    const body = (await res.json().catch(() => null)) as { key?: MirrorAccountKey | null } | null;
    const parsed = humanKeyFromMirrorAccount(body);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: `can't use this account for a vault: ${parsed.error}`, guidance: parsed.guidance },
        { status: 400 },
      );
    }
    humanKey = parsed;
  } catch {
    return NextResponse.json({ error: "mirror node unreachable — try again in a moment" }, { status: 502 });
  }

  let built;
  try {
    built = buildVaultCreateTx({
      humanKey: humanKey.publicKey,
      agentKey: PublicKey.fromStringED25519(pkg.agentPublicKey),
      budgetHbar: pkg.budgetHbar,
      agentUsername: pkg.agentUsername,
      payerAccountId: humanAccountId,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "couldn't build the vault transaction" },
      { status: 500 },
    );
  }

  const cost = await estimateVaultSetupCost(pkg.budgetHbar);
  return NextResponse.json({
    unsigned_tx_bytes: built.unsignedTxBytes,
    transaction_id: built.transactionId,
    tx_type: built.txType,
    human_account_id: humanAccountId,
    human_key_fingerprint: `${humanKey.keyHex.slice(0, 8)}…${humanKey.keyHex.slice(-8)}`,
    agent_username: pkg.agentUsername,
    budget_hbar: pkg.budgetHbar,
    exact_total: formatCostLine(cost),
    what_youre_signing:
      `ONE signature creates your agent's spending account on Hedera — a new account co-owned by ` +
      `you and @${pkg.agentUsername}. Either of you can use it on its own, so the agent can pay its ` +
      `own gas without asking you every time. It starts with ${pkg.budgetHbar} HBAR ` +
      `of your funding for the agent's gas. ` +
      `You can cut the agent off any time with one more signature (~$0.05).`,
  });
}
