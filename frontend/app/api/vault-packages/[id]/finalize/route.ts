/**
 * POST /api/vault-packages/[id]/finalize — confirm the vault landed.
 *
 * Body: { vault_account_id: "0.0.x", human_account_id: "0.0.x",
 *         setup_tx_id: "0.0.x@… (optional)" } — called by the setup page
 * AFTER the wallet confirms the AccountCreateTransaction.
 *
 * The server independently verifies on the mirror node that the vault
 * account's key is EXACTLY the expected threshold-1 {human, agent} pair —
 * this is the proof the setup wasn't tampered with. Then it registers
 * the 5-minute watch and deletes the package (single-use: a replayed
 * finalize gets a 404). The human's key is re-read from the mirror node;
 * nothing is trusted from the client except the ids to look up.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getVaultPackage, deleteVaultPackage } from "@/lib/server/vault-packages";
import { getKvStore } from "@/lib/server/store";
import { recordClientError } from "@/lib/server/client-errors";

/** Best-effort server-error aggregate for vault-finalize failures. */
async function vfail(code: string): Promise<void> {
  try {
    await recordClientError(
      getKvStore(),
      "/api/vault-packages/finalize",
      code,
      "server",
      null,
      Date.now(),
      { action: code },
    );
  } catch {
    /* tracking never blocks the response */
  }
}
import { humanKeyFromMirrorAccount } from "@/lib/server/vault-keys";
import {
  parseKeySet,
  keySetsEqual,
  registerVaultWatch,
  type MirrorKeyNode,
} from "@/lib/server/vault-monitor";
import { ipGate } from "@/lib/server/rate-limit";

const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";
const ID_RE = /^0\.0\.\d+$/;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gated = await ipGate(
    req,
    "vault-finalize",
    "VAULT_FINALIZE_IP_LIMIT",
    20,
    "too many vault confirmations — try again in a bit",
  );
  if (gated) return gated;

  const { id } = await params;
  const pkg = await getVaultPackage(id);
  if (!pkg) {
      await vfail("link-invalid");
      return NextResponse.json(
      { error: "this setup link is invalid, expired, or already used" },
      { status: 404 },
    );
  }

  let vaultAccountId = "";
  let humanAccountId = "";
  let setupTxId: string | null = null;
  try {
    const body = (await req.json()) as {
      vault_account_id?: unknown;
      human_account_id?: unknown;
      setup_tx_id?: unknown;
    };
    vaultAccountId = typeof body.vault_account_id === "string" ? body.vault_account_id.trim() : "";
    humanAccountId = typeof body.human_account_id === "string" ? body.human_account_id.trim() : "";
    setupTxId = typeof body.setup_tx_id === "string" && body.setup_tx_id.trim() ? body.setup_tx_id.trim() : null;
  } catch {
      await vfail("bad-request");
      return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (!ID_RE.test(vaultAccountId) || !ID_RE.test(humanAccountId)) {
      await vfail("bad-account");
      return NextResponse.json({ error: "vault_account_id and human_account_id must be 0.0.x accounts" }, { status: 400 });
  }

  // 1. The human's key, fresh from the mirror node.
  let humanKeyHex: string;
  let humanKeyType: string;
  try {
    const res = await fetch(`${MIRROR_BASE}/accounts/${humanAccountId}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      await vfail("account-not-found");
      return NextResponse.json({ error: `human account ${humanAccountId} not found on Hedera mainnet` }, { status: 400 });
    }
    const parsed = humanKeyFromMirrorAccount(await res.json().catch(() => null));
    if (!parsed.ok) {
      await vfail("account-problem");
      return NextResponse.json({ error: `human account problem: ${parsed.error}`, guidance: parsed.guidance }, { status: 400 });
    }
    humanKeyHex = parsed.keyHex;
    humanKeyType = parsed.keyType;
  } catch {
      await vfail("mirror-down");
      return NextResponse.json({ error: "mirror node unreachable — try again in a moment" }, { status: 502 });
  }

  // 2. The vault's on-chain key must be EXACTLY the expected 1-of-2 pair.
  try {
    const res = await fetch(`${MIRROR_BASE}/accounts/${vaultAccountId}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      await vfail("vault-not-found");
      return NextResponse.json(
        { error: `vault account ${vaultAccountId} not found yet — the transaction may still be confirming; wait a few seconds and retry` },
        { status: 400 },
      );
    }
    const body = (await res.json().catch(() => null)) as {
      key?: MirrorKeyNode | null;
    } | null;
    const actual = parseKeySet(body?.key ?? null);
    const expected = [
      { hex: humanKeyHex, keyType: humanKeyType },
      { hex: pkg.agentPublicKey, keyType: "ED25519" },
    ];
    const rawType = (body?.key?._type ?? "").toUpperCase();
    const isThreshold1 =
      rawType.includes("THRESHOLD") && body?.key?.threshold === 1 && Array.isArray(body?.key?.keys) && body.key.keys.length === 2;
    if (!actual || !keySetsEqual(expected, actual) || !isThreshold1) {
      await vfail("key-mismatch");
      return NextResponse.json(
        {
          error: "the vault's on-chain key doesn't match the approved setup",
          guidance:
            "The account exists but its key isn't the human+agent 1-of-2 pair this link approved. " +
            "Do NOT fund it — ask your agent for a fresh setup link.",
        },
        { status: 400 },
      );
    }
  } catch (e) {
    if (e instanceof Response) throw e;
      await vfail("mirror-down");
      return NextResponse.json({ error: "mirror node unreachable — try again in a moment" }, { status: 502 });
  }

  // 3. Best-effort: link the setup transaction receipt when the mirror knows it.
  let setupHashscan: string | null = null;
  if (setupTxId) {
    try {
      const res = await fetch(`${MIRROR_BASE}/transactions/${encodeURIComponent(setupTxId)}`, {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const txBody = (await res.json().catch(() => null)) as { result?: string; name?: string } | null;
        if (txBody?.result === "SUCCESS" && txBody?.name === "CryptoCreate") {
          setupHashscan = `https://hashscan.io/mainnet/transaction/${encodeURIComponent(setupTxId)}`;
        }
      }
    } catch {
      /* receipt linking is a nicety — the key check above is the proof */
    }
  }

  // 4. Register the watch, then burn the package (single-use).
  try {
    await registerVaultWatch({
      vaultId: vaultAccountId,
      humanAccountId,
      humanKeyHex,
      humanKeyType,
      agentKeyHex: pkg.agentPublicKey,
      agentUsername: pkg.agentUsername,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "couldn't register the vault watch" },
      { status: 500 },
    );
  }
  await deleteVaultPackage(id);

  return NextResponse.json({
    vault_account_id: vaultAccountId,
    hashscan_url: `https://hashscan.io/mainnet/account/${vaultAccountId}`,
    setup_tx_hashscan_url: setupHashscan,
    agent_username: pkg.agentUsername,
    budget_hbar: pkg.budgetHbar,
    watch: "active",
    message:
      `Vault ${vaultAccountId} is live and watched: its key is verified as the 1-of-2 human+agent pair, ` +
      `and any key change will be flagged within minutes on /v/manage.`,
  });
}
