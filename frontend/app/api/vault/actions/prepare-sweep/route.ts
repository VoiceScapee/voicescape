/**
 * POST /api/vault/actions/prepare-sweep — build the UNSIGNED fund sweep.
 *
 * Body: { vault_account_id: "0.0.x", human_account_id: "0.0.x" }.
 * The vault must be watched under that human. The server reads the
 * vault's LIVE balance and builds a vault→human transfer of everything
 * above the 0.6 HBAR fee cushion — the destination is ALWAYS the human,
 * never an arbitrary recipient.
 *
 * Safe by construction: money can only flow to the human owner, and the
 * vault pays its own fee. (An agent calling this can only return funds
 * to the human — that's a feature.) Rate-limited per IP. Never signs.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getVaultWatch } from "@/lib/server/vault-monitor";
import { buildVaultSweepTx, SWEEP_FEE_CUSHION_TINYBAR } from "@/lib/server/vault-tx";
import { ipGate } from "@/lib/server/rate-limit";

const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";
const ID_RE = /^0\.0\.\d+$/;

export async function POST(req: Request): Promise<Response> {
  const gated = await ipGate(req, "vault-sweep", "VAULT_SWEEP_IP_LIMIT", 20, "too many sweep attempts — try again in a bit");
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
      { error: "this vault isn't registered under that account — only the vault's human owner can sweep it" },
      { status: 403 },
    );
  }

  let balanceTinybar: bigint;
  try {
    const res = await fetch(`${MIRROR_BASE}/accounts/${vaultAccountId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: `vault account ${vaultAccountId} not found on Hedera mainnet` }, { status: 400 });
    }
    const body = (await res.json().catch(() => null)) as { balance?: { balance?: number } } | null;
    const bal = body?.balance?.balance;
    if (typeof bal !== "number") {
      return NextResponse.json({ error: "couldn't read the vault balance — try again in a moment" }, { status: 502 });
    }
    balanceTinybar = BigInt(bal);
  } catch {
    return NextResponse.json(
      { error: "mirror node unreachable — try again in a moment", code: "MIRROR_UNAVAILABLE", retryable: true },
      { status: 502 },
    );
  }

  let built;
  try {
    built = buildVaultSweepTx({
      vaultAccountId,
      humanAccountId,
      vaultBalanceTinybar: balanceTinybar,
      payerAccountId: vaultAccountId,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "couldn't build the sweep" },
      { status: 400 },
    );
  }

  const amountTinybar = balanceTinybar - SWEEP_FEE_CUSHION_TINYBAR;
  return NextResponse.json({
    unsigned_tx_bytes: built.unsignedTxBytes,
    transaction_id: built.transactionId,
    tx_type: built.txType,
    vault_account_id: vaultAccountId,
    human_account_id: humanAccountId,
    amount_hbar: Number(amountTinybar) / 100_000_000,
    fee_cushion_hbar: Number(SWEEP_FEE_CUSHION_TINYBAR) / 100_000_000,
    what_youre_signing:
      `ONE TransferTransaction: ${Number(amountTinybar) / 100_000_000} HBAR moves from the vault to YOUR account ` +
      `${humanAccountId}. 0.6 HBAR stays behind so the transfer can pay its own fee. ` +
      `The destination is always you — this transaction cannot send funds anywhere else.`,
  });
}
