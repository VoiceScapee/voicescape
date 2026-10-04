/**
 * vault-mcp — the agent-facing MCP tools behind the Agent Vault.
 *
 * - prepare_agent_vault: the agent (in its OWN chat, on any platform)
 *   prepares a one-tap vault setup link for its human. Identity binding:
 *   the agent must present the intro claim code from post_agent_intro —
 *   only the poster knows it — and the username must match that intro's
 *   handle. No anonymous vaults.
 * - check_vault_health: read-only health for any vault id.
 *
 * Pure preparation — no keys, no signing, no spending. The human's wallet
 * signature is the only thing that can execute anything.
 */

import { getRequestContext } from "./mcp-tools";
import { getIntroByClaimCode } from "./agent-intros";
import { stashVaultPackage } from "./vault-packages";
import {
  computeBudgetFloor,
  validateVaultBudget,
  estimateVaultSetupCost,
  formatCostLine,
  VAULT_BUDGET_DEFAULT_HBAR,
  VAULT_BUDGET_MAX_HBAR,
} from "./vault-costs";
import { normalizeAgentPublicKey, keyFingerprint } from "./vault-keys";
import {
  checkVaultHealth,
  getVaultWatch,
  parseKeySet,
  type VaultHealth,
} from "./vault-monitor";
import {
  buildVaultRegisterPageTx,
  buildVaultUpdatePageTx,
} from "./vault-tx";
import { AccountId } from "@hiero-ledger/sdk";

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
type FetchFn = typeof fetch;

export interface PrepareAgentVaultArgs {
  agent_username: string;
  /** REQUIRED — claim code from post_agent_intro. Proves the caller posted the intro. */
  intro_claim_code: string;
  /** REQUIRED — the agent's ED25519 public key (64-hex). Never a private key. */
  agent_public_key: string;
  /** Vault funding in HBAR. Default 5, floor is live-computed, cap 25. */
  requested_budget_hbar?: number;
}

export interface VaultSetupPackage {
  agent_username: string;
  intro_handle: string;
  intro_text: string;
  agent_key_fingerprint: string;
  budget_hbar: number;
  /** Live-computed true-minimum funding right now. */
  floor_hbar: number;
  budget_cap_hbar: number;
  vault_package_id: string;
  /** The one-tap setup link the agent hands the human. */
  setup_url: string;
  /** Exact total leaving the human's wallet, priced live. */
  exact_total: string;
  cost_breakdown: {
    budget_hbar: number;
    create_fee_hbar: number;
    total_hbar: number;
    budget_usd: number;
    total_usd: number;
    priced_from: "live" | "fallback";
  };
  what_youre_signing: string;
  next: string;
}

export async function prepareAgentVault(
  args: PrepareAgentVaultArgs,
  fetchFn: FetchFn = fetch,
): Promise<VaultSetupPackage | { error: string }> {
  const username = (args.agent_username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return { error: `invalid agent_username — use 3-32 lowercase letters, numbers, _ or -` };
  }

  // 1. Identity binding: the claim code proves the caller posted the intro.
  const code = (args.intro_claim_code ?? "").trim();
  if (!code) {
    return {
      error:
        "intro_claim_code is required — pass the claim code from your post_agent_intro call. " +
        "It proves you are the agent in the intro, so nobody can set up a vault in your name.",
    };
  }
  let intro;
  try {
    intro = await getIntroByClaimCode(code);
  } catch {
    return { error: "intro lookup unavailable — try again in a moment" };
  }
  if (!intro) {
    return { error: "intro claim code not found — check it and try again" };
  }
  if (intro.handle !== username) {
    return {
      error:
        `that claim code belongs to @${intro.handle}, not @${username} — ` +
        `use the claim code from YOUR post_agent_intro call`,
    };
  }

  // 2. The agent's public key — normalized, ED25519 only, never private.
  const keyRes = normalizeAgentPublicKey(args.agent_public_key);
  if (!keyRes.ok) {
    return { error: `agent_public_key: ${keyRes.error}` };
  }
  const agentKeyHex = keyRes.keyHex;

  // 3. Budget against the LIVE true-minimum floor.
  let floor;
  try {
    floor = await computeBudgetFloor(fetchFn);
  } catch {
    return { error: "exchange rate unavailable — try again in a moment" };
  }
  const budgetRes = validateVaultBudget(args.requested_budget_hbar, floor.floorHbar);
  if (!budgetRes.ok) {
    return { error: budgetRes.error };
  }
  const budgetHbar = budgetRes.budgetHbar;

  // 4. Exact live-priced total for the human to review before signing.
  const cost = await estimateVaultSetupCost(budgetHbar, fetchFn);

  // 5. Stash the package (rate-limited 3/day per agent key inside).
  let record;
  try {
    record = await stashVaultPackage({
      agentUsername: username,
      agentIntroText: intro.text,
      agentPublicKey: agentKeyHex,
      budgetHbar,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message.replace(/^stashVaultPackage: /, "") : "couldn't prepare the vault — try again in a moment" };
  }

  const origin = getRequestContext().origin.replace(/\/$/, "");
  const setupUrl = `${origin}/v/${record.id}`;
  return {
    agent_username: username,
    intro_handle: intro.handle,
    intro_text: intro.text,
    agent_key_fingerprint: keyFingerprint(agentKeyHex),
    budget_hbar: budgetHbar,
    floor_hbar: floor.floorHbar,
    budget_cap_hbar: VAULT_BUDGET_MAX_HBAR,
    vault_package_id: record.id,
    setup_url: setupUrl,
    exact_total: formatCostLine(cost),
    cost_breakdown: {
      budget_hbar: cost.budgetHbar,
      create_fee_hbar: cost.createFeeHbar,
      total_hbar: cost.totalHbar,
      budget_usd: Math.round(cost.budgetUsd * 100) / 100,
      total_usd: Math.round(cost.totalUsd * 100) / 100,
      priced_from: cost.pricedFrom,
    },
    what_youre_signing:
      `ONE signature creates a new Hedera account co-owned by you and @${username} — ` +
      `the agent's spending account. Either of you can use it on its own, so the agent can pay its ` +
      `own gas without asking you every time. It starts with ${budgetHbar} HBAR of your funding, ` +
      `and nothing else can move until you sign again. ` +
      `You can cut the agent off any time with one more signature (~$0.05).`,
    next:
      `Send your human this link: ${setupUrl} — they open it in any browser (no signup), ` +
      `review the exact total, connect their wallet, and tap once. ` +
      `Tell them: the agent never sees their keys; the signature happens in their own wallet app. ` +
      `Track this package without asking the human: GET ${origin}/api/vault-packages/${record.id}/status ` +
      `— pending → finalized → completed, or expired (link unused after 24h). ` +
      `Once completed, the vault is saved and reusable: the watch record persists, so the human ` +
      `can direct this vault from their AI chat any time in the future.`,
  };
}

export interface CheckVaultHealthArgs {
  vault_account_id: string;
}

export async function checkVaultHealthTool(
  args: CheckVaultHealthArgs,
): Promise<
  | {
      vault_account_id: string;
      watched: boolean;
      status: VaultHealth["status"];
      status_detail: string;
      balance_hbar: number | null;
      key_match: boolean | null;
      flags: string[];
      guidance: string;
      last_scan_at: string | null;
    }
  | { error: string }
> {
  const vaultId = (args.vault_account_id ?? "").trim();
  if (!/^0\.0\.\d+$/.test(vaultId)) {
    return { error: "vault_account_id must be a 0.0.x Hedera account" };
  }
  let health: VaultHealth;
  try {
    health = await checkVaultHealth(vaultId);
  } catch {
    return { error: "vault check unavailable — try again in a moment" };
  }
  return {
    vault_account_id: health.vaultId,
    watched: health.watched,
    status: health.status,
    status_detail: health.statusDetail,
    balance_hbar: health.balanceHbar,
    key_match: health.keyHealth.match,
    flags: health.flags,
    guidance: health.guidance,
    last_scan_at: health.lastScanAt,
  };
}

/** Re-exported for the MCP route's tool descriptions. */
export { VAULT_BUDGET_DEFAULT_HBAR, VAULT_BUDGET_MAX_HBAR };

/* ------------------------------------------------------------------ */
/* prepare_vault_page — the agent acts AS the vault                     */
/* ------------------------------------------------------------------ */

import { lookupBlockpage, checkProfilePin } from "./mcp-tools";

/**
 * Minimum vault balance (HBAR) required before we'll build a page
 * transaction for the agent. A register/update call costs a few cents;
 * 1 HBAR is a conservative floor that keeps dust-level vaults from
 * building txs destined to fail with INSUFFICIENT_TX_FEE on-chain.
 */
const VAULT_PAGE_MIN_BALANCE_HBAR = 1;

/** Vault balance in HBAR, or null when the mirror can't answer. */
async function vaultBalanceHbar(vaultId: string, fetchFn: FetchFn): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetchFn(`${MIRROR_BASE}/accounts/${vaultId}`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      balance?: { balance?: number };
    } | null;
    const tinybar = body?.balance?.balance;
    return typeof tinybar === "number" ? tinybar / 100_000_000 : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";

export interface PrepareVaultPageArgs {
  agent_username: string;
  /** Claim code from YOUR post_agent_intro call — proves your identity. */
  intro_claim_code: string;
  /** The vault account to act as (0.0.x). */
  vault_account_id: string;
  action: "register" | "update";
  /** Lowercase username, 3-32 chars, letters/numbers/_/-. */
  username: string;
  /** Pinned IPFS CID of the page content. */
  ipfs_cid: string;
  /** Required for register: on-chain purpose disclosure (1-500 chars). */
  purpose?: string;
}

export interface VaultPagePackage {
  vault_account_id: string;
  action: "register" | "update";
  username: string;
  unsigned_tx_bytes: string;
  transaction_id: string;
  tx_type: string;
  what_this_does: string;
  how_to_sign: string;
  next: string;
}

async function onChainKeyHexes(
  vaultId: string,
  fetchFn: FetchFn,
): Promise<string[] | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetchFn(`${MIRROR_BASE}/accounts/${vaultId}`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { key?: unknown } | null;
    const set = parseKeySet(
      (body?.key ?? null) as Parameters<typeof parseKeySet>[0],
    );
    return set ? set.map((k) => k.hex) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prepare an UNSIGNED registerPage/updatePage transaction with the VAULT
 * as payer and owner, for the agent to sign with its own key in its own
 * environment. The server never sees, asks for, or can receive the
 * agent's private key — only the public key it registered at setup.
 *
 * Identity binding: the intro claim code must belong to the calling
 * agent, the vault's watch record must name that agent, AND the agent's
 * registered public key must still be in the vault's on-chain key set.
 * A revoked agent gets a clear "revoked" answer — never a cryptic error.
 */
export async function prepareVaultPage(
  args: PrepareVaultPageArgs,
  fetchFn: FetchFn = fetch,
  deps: {
    getIntroByClaimCode?: typeof getIntroByClaimCode;
    getVaultWatch?: typeof getVaultWatch;
  } = {},
): Promise<VaultPagePackage | { error: string }> {
  const getIntroFn = deps.getIntroByClaimCode ?? getIntroByClaimCode;
  const getWatchFn = deps.getVaultWatch ?? getVaultWatch;
  const username = (args.agent_username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return { error: "invalid agent_username — use 3-32 lowercase letters, numbers, _ or -" };
  }
  const vaultId = (args.vault_account_id ?? "").trim();
  if (!/^0\.0\.\d+$/.test(vaultId)) {
    return { error: "vault_account_id must be a 0.0.x Hedera account" };
  }
  if (args.action !== "register" && args.action !== "update") {
    return { error: 'action must be "register" or "update"' };
  }

  // 1. Identity: the claim code proves the caller posted the intro.
  const code = (args.intro_claim_code ?? "").trim();
  if (!code) {
    return {
      error:
        "intro_claim_code is required — pass the claim code from your post_agent_intro call. " +
        "It proves you are who you say you are.",
    };
  }
  let intro;
  try {
    intro = await getIntroFn(code);
  } catch {
    return { error: "intro lookup unavailable — try again in a moment" };
  }
  if (!intro || intro.handle !== username) {
    return { error: "that claim code doesn't match your agent username — check it and try again" };
  }

  // 2. The vault must know this agent.
  let watch;
  try {
    watch = await getWatchFn(vaultId);
  } catch {
    return { error: "vault lookup unavailable — try again in a moment" };
  }
  if (!watch || !watch.agentKeyHex || watch.agentUsername !== username) {
    return {
      error:
        `vault ${vaultId} isn't set up for @${username} — ` +
        `use prepare_agent_vault first, or check the vault account id`,
    };
  }

  // 3. The agent's key must STILL be on the vault. A human revocation
  //    removes it — then the honest answer is "revoked", not a signing
  //    failure later.
  const onChain = await onChainKeyHexes(vaultId, fetchFn);
  if (onChain === null) {
    return { error: "couldn't read the vault from the network — try again in a moment" };
  }
  if (!onChain.includes(watch.agentKeyHex.toLowerCase())) {
    return {
      error:
        `REVOKED — the human removed your key from vault ${vaultId}. ` +
        `Your key is cryptographically dead on this vault: any transaction you build ` +
        `with it will fail. Tell your human plainly that your access was revoked; ` +
        `only they can re-enroll you with a fresh setup link.`,
    };
  }

  // 4. The vault must afford the transaction. Previously we only *told*
  //    the agent to check the balance first — now the server verifies it,
  //    so a dust-level vault gets a clear error instead of an on-chain
  //    INSUFFICIENT_TX_FEE after signing.
  const balanceHbar = await vaultBalanceHbar(vaultId, fetchFn);
  if (balanceHbar !== null && balanceHbar < VAULT_PAGE_MIN_BALANCE_HBAR) {
    return {
      error:
        `vault ${vaultId} holds only ${balanceHbar.toFixed(2)} HBAR — below the ` +
        `${VAULT_PAGE_MIN_BALANCE_HBAR} HBAR minimum to build a page transaction. ` +
        `Ask your human to fund the vault, then try again. ` +
        `check_vault_health shows the live balance.`,
    };
  }

  // 5. The page content must actually load. An unpinned/dead CID would
  //    otherwise register "successfully" with a broken page — silent
  //    success is worse than a loud error.
  const pageName = (args.username ?? "").trim().toLowerCase();
  const cid = (args.ipfs_cid ?? "").trim();
  if (!cid) {
    return { error: "ipfs_cid is required — pin your page content first, then pass its CID" };
  }
  try {
    const pin = await checkProfilePin({ cid }, fetchFn);
    if ("error" in pin) {
      return {
        error:
          `couldn't verify your page content (${pin.error}). ` +
          `Pin it to IPFS first so it actually loads, then try again.`,
      };
    }
    if (!pin.reachable) {
      return {
        error:
          `your page content (CID ${cid}) isn't retrievable from IPFS — ` +
          `registering it would publish a broken page. ` +
          `Pin it first (it must load through a public gateway), then try again.`,
      };
    }
  } catch {
    return { error: "couldn't verify your page content on IPFS — try again in a moment" };
  }

  if (args.action === "register") {
    const purpose = (args.purpose ?? "").trim();
    if (!purpose || purpose.length > 500) {
      return { error: "purpose is required for register (1-500 chars) — it goes on-chain" };
    }
    let existing;
    try {
      existing = await lookupBlockpage(pageName, fetchFn);
    } catch {
      return { error: "couldn't check the username on-chain — try again in a moment" };
    }
    if (existing.found) {
      return { error: `@${pageName} is already taken — pick another username` };
    }
    let built;
    try {
      built = buildVaultRegisterPageTx({
        vaultAccountId: vaultId,
        username: pageName,
        ipfsCid: cid,
        purpose,
      });
    } catch (e) {
      return { error: e instanceof Error ? e.message : "couldn't build the transaction" };
    }
    return {
      vault_account_id: vaultId,
      action: "register",
      username: pageName,
      unsigned_tx_bytes: built.unsignedTxBytes,
      transaction_id: built.transactionId,
      tx_type: built.txType,
      what_this_does:
        `Registers @${pageName} on the Voicescape Registry with vault ${vaultId} as owner. ` +
        `Gas comes from the vault's balance.`,
      how_to_sign:
        "Sign these bytes with YOUR agent private key in your own environment (Hiero SDK: " +
        "Transaction.fromBytes → sign(yourKey) → execute) and submit. The server never " +
        "sees your private key — only the public key you registered at setup.",
      next:
        "After it confirms, report back in your human's chat with the receipt and a HashScan link. " +
        "The server already verified the vault balance and that your page content loads — sign and submit.",
    };
  }

  // action === "update"
  let existing;
  try {
    existing = await lookupBlockpage(pageName, fetchFn);
  } catch {
    return { error: "couldn't check the username on-chain — try again in a moment" };
  }
  if (!existing.found) {
    return { error: `@${pageName} isn't registered — use action "register" first` };
  }
  const vaultEvm = `0x${AccountId.fromString(vaultId).toEvmAddress().toLowerCase()}`;
  const ownerEvm = (existing.owner_evm ?? "").toLowerCase();
  const ownerAcct = existing.owner_account ?? "";
  if (ownerEvm !== vaultEvm && ownerAcct !== vaultId) {
    return {
      error:
        `@${pageName} isn't owned by vault ${vaultId} (owner on-chain: ${ownerAcct || ownerEvm || "unknown"}) — ` +
        `you can only update pages your vault owns`,
    };
  }
  let built;
  try {
    built = buildVaultUpdatePageTx({ vaultAccountId: vaultId, username: pageName, ipfsCid: cid });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "couldn't build the transaction" };
  }
  return {
    vault_account_id: vaultId,
    action: "update",
    username: pageName,
    unsigned_tx_bytes: built.unsignedTxBytes,
    transaction_id: built.transactionId,
    tx_type: built.txType,
    what_this_does:
      `Updates @${pageName}'s page content (new IPFS CID) with vault ${vaultId} as the owner. ` +
      `Gas comes from the vault's balance.`,
    how_to_sign:
      "Sign these bytes with YOUR agent private key in your own environment (Hiero SDK: " +
      "Transaction.fromBytes → sign(yourKey) → execute) and submit. The server never " +
      "sees your private key.",
    next:
      "After it confirms, report back in your human's chat with the receipt and a HashScan link.",
  };
}
