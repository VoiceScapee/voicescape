/**
 * vault-link — client helpers for the Agent Vault setup link (/v/<id>)
 * and the /v/manage dashboard.
 *
 * Pairing (DAppConnector) is the only auth — no session. Flow:
 * fetch the package summary → review the exact total → tap Approve →
 * prepare (server builds the frozen tx with the paired wallet as payer)
 * → submitPreparedTx (wallet signs, mirror confirms) → finalize (server
 * verifies the on-chain key, registers the watch, burns the package).
 */
export interface VaultCostBreakdown {
  budget_hbar: number;
  create_fee_hbar: number;
  total_hbar: number;
  budget_usd: number;
  total_usd: number;
  priced_from: "live" | "fallback";
}

export interface VaultSummary {
  agent_username: string;
  agent_intro_text: string;
  agent_key_fingerprint: string;
  budget_hbar: number;
  floor_hbar: number;
  floor_live: boolean;
  cost_breakdown: VaultCostBreakdown;
  exact_total: string;
  created_at: string;
}

export interface PreparedVaultTx {
  unsigned_tx_bytes: string;
  transaction_id: string;
  tx_type: string;
  what_youre_signing: string;
  [key: string]: unknown;
}

export interface VaultFinalized {
  vault_account_id: string;
  hashscan_url: string;
  setup_tx_hashscan_url: string | null;
  agent_username: string;
  budget_hbar: number;
  watch: string;
  message: string;
}

export interface VaultHealthView {
  vault_account_id: string;
  watched: boolean;
  status: string;
  status_detail: string;
  balance_hbar: number | null;
  key_match: boolean | null;
  key_fingerprint?: string[] | null;
  flags: string[];
  guidance: string;
  last_scan_at: string | null;
  hashscan_url: string;
}

export class VaultLinkError extends Error {}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const serverMsg =
    typeof body?.error === "string" && body.error ? body.error : null;
  const guidance =
    typeof body?.guidance === "string" && body.guidance ? ` ${body.guidance}` : "";
  return (serverMsg ?? fallback) + guidance;
}

/** Read the public summary for a short setup id. Throws VaultLinkError when invalid/expired. */
export async function fetchVaultSummary(id: string): Promise<VaultSummary> {
  let res: Response;
  try {
    res = await fetch(`/api/vault-packages/${encodeURIComponent(id)}`, { cache: "no-store" });
  } catch {
    throw new VaultLinkError("Couldn't reach Voicescape — check your connection and retry.");
  }
  if (!res.ok) {
    throw new VaultLinkError(await readError(res, "This setup link is invalid or expired — ask your agent for a fresh one."));
  }
  return (await res.json()) as VaultSummary;
}

/** Build the frozen unsigned vault-creation tx for the paired wallet. */
export async function prepareVaultSetup(
  packageId: string,
  humanAccountId: string,
): Promise<PreparedVaultTx> {
  let res: Response;
  try {
    res = await fetch("/api/vault/actions/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package_id: packageId, human_account_id: humanAccountId }),
    });
  } catch {
    throw new VaultLinkError("Couldn't reach Voicescape — check your connection and retry.");
  }
  if (!res.ok) {
    throw new VaultLinkError(await readError(res, "Couldn't prepare the vault transaction — try again in a moment."));
  }
  return (await res.json()) as PreparedVaultTx;
}

/**
 * Confirm the vault after the wallet signs: the server verifies the
 * on-chain key, registers the watch, and burns the package (single-use).
 */
export async function finalizeVaultSetup(
  packageId: string,
  vaultAccountId: string,
  humanAccountId: string,
  setupTxId: string | null,
): Promise<VaultFinalized> {
  let res: Response;
  try {
    res = await fetch(`/api/vault-packages/${encodeURIComponent(packageId)}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vault_account_id: vaultAccountId,
        human_account_id: humanAccountId,
        setup_tx_id: setupTxId,
      }),
    });
  } catch {
    throw new VaultLinkError("Couldn't reach Voicescape — the vault may still be confirming; check HashScan, then retry.");
  }
  if (!res.ok) {
    throw new VaultLinkError(await readError(res, "Couldn't confirm the vault — try again in a moment."));
  }
  return (await res.json()) as VaultFinalized;
}

/** Derive the new vault's account id from the setup tx's mirror record. */
export async function vaultIdFromSetupTx(setupTxId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://mainnet.mirrornode.hedera.com/api/v1/transactions/${encodeURIComponent(setupTxId)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { entity_id?: string } | null;
    return typeof body?.entity_id === "string" && /^0\.0\.\d+$/.test(body.entity_id)
      ? body.entity_id
      : null;
  } catch {
    return null;
  }
}

/** Read-only health for one vault. */
export async function fetchVaultHealth(vaultId: string): Promise<VaultHealthView> {
  let res: Response;
  try {
    res = await fetch(`/api/vault/watch/${encodeURIComponent(vaultId)}`, { cache: "no-store" });
  } catch {
    throw new VaultLinkError("Couldn't reach Voicescape — check your connection and retry.");
  }
  if (!res.ok) {
    throw new VaultLinkError(await readError(res, "Couldn't check the vault — try again in a moment."));
  }
  return (await res.json()) as VaultHealthView;
}

/** All vaults registered under a human account, with health. */
export async function fetchMyVaults(humanAccountId: string): Promise<{ vaults: VaultHealthView[] }> {
  let res: Response;
  try {
    res = await fetch(`/api/vault/mine?human_account_id=${encodeURIComponent(humanAccountId)}`, { cache: "no-store" });
  } catch {
    throw new VaultLinkError("Couldn't reach Voicescape — check your connection and retry.");
  }
  if (!res.ok) {
    throw new VaultLinkError(await readError(res, "Couldn't list your vaults — try again in a moment."));
  }
  return (await res.json()) as { vaults: VaultHealthView[] };
}

/** Build the frozen unsigned revocation tx (vault key → human-only). */
export async function prepareVaultRevoke(
  vaultAccountId: string,
  humanAccountId: string,
): Promise<PreparedVaultTx> {
  let res: Response;
  try {
    res = await fetch("/api/vault/actions/prepare-revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vault_account_id: vaultAccountId, human_account_id: humanAccountId }),
    });
  } catch {
    throw new VaultLinkError("Couldn't reach Voicescape — check your connection and retry.");
  }
  if (!res.ok) {
    throw new VaultLinkError(await readError(res, "Couldn't prepare the revocation — try again in a moment."));
  }
  return (await res.json()) as PreparedVaultTx;
}

/** Build the frozen unsigned sweep (vault → human, fee cushion kept). */
export async function prepareVaultSweep(
  vaultAccountId: string,
  humanAccountId: string,
): Promise<PreparedVaultTx & { amount_hbar: number; fee_cushion_hbar: number }> {
  let res: Response;
  try {
    res = await fetch("/api/vault/actions/prepare-sweep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vault_account_id: vaultAccountId, human_account_id: humanAccountId }),
    });
  } catch {
    throw new VaultLinkError("Couldn't reach Voicescape — check your connection and retry.");
  }
  if (!res.ok) {
    throw new VaultLinkError(await readError(res, "Couldn't prepare the sweep — try again in a moment."));
  }
  return (await res.json()) as PreparedVaultTx & { amount_hbar: number; fee_cushion_hbar: number };
}

/** Build the frozen unsigned "sign as vault" update (human signs for a page the vault owns). */
export async function prepareVaultUpdate(
  vaultAccountId: string,
  humanAccountId: string,
  username: string,
  ipfsCid: string,
): Promise<PreparedVaultTx> {
  let res: Response;
  try {
    res = await fetch("/api/vault/actions/prepare-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vault_account_id: vaultAccountId,
        human_account_id: humanAccountId,
        username,
        ipfs_cid: ipfsCid,
      }),
    });
  } catch {
    throw new VaultLinkError("Couldn't reach Voicescape — check your connection and retry.");
  }
  if (!res.ok) {
    throw new VaultLinkError(await readError(res, "Couldn't prepare the update — try again in a moment."));
  }
  return (await res.json()) as PreparedVaultTx;
}

/** Register a watch for a vault created outside the setup-link flow. */
export async function registerVaultWatchClient(
  vaultAccountId: string,
  humanAccountId: string,
  agentPublicKey?: string,
  agentUsername?: string,
): Promise<{ watched: boolean; message: string; key_verification: string }> {
  let res: Response;
  try {
    res = await fetch("/api/vault/watch/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vault_account_id: vaultAccountId,
        human_account_id: humanAccountId,
        agent_public_key: agentPublicKey,
        agent_username: agentUsername,
      }),
    });
  } catch {
    throw new VaultLinkError("Couldn't reach Voicescape — check your connection and retry.");
  }
  if (!res.ok) {
    throw new VaultLinkError(await readError(res, "Couldn't register the watch — try again in a moment."));
  }
  return (await res.json()) as { watched: boolean; message: string; key_verification: string };
}
