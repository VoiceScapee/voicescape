/**
 * vault-packages — KV-backed store for Agent Vault setup packages behind
 * short links (/v/<id>).
 *
 * The agent's MCP call (prepare_agent_vault) stashes a package here: the
 * human gets a short URL, opens it in any browser, reviews WHO they are
 * co-owning with (agent username + intro + key fingerprint), reads the
 * plain-words consent, sees the exact HBAR total, then signs ONE
 * AccountCreateTransaction. Pairing is the only auth — no session.
 *
 * Safety properties (gap review):
 * - Identity binding: the package records the agent's username, intro
 *   text snapshot, and public-key fingerprint. No anonymous vaults.
 * - Per-agent rate limit: 3 packages / 24h per agent public key.
 * - 24h TTL; single-use — deleted at finalize, no replay.
 * - No private keys anywhere: the schema physically has no field for one.
 *   The agent's key arrives as a PUBLIC key; the human's key is read from
 *   the mirror node at finalize time.
 */

import { randomBytes } from "node:crypto";
import { getKvStore, type KvStore } from "./store";

export interface VaultPackageInput {
  /** Agent handle — must match a posted intro (verified by the caller). */
  agentUsername: string;
  /** Snapshot of the intro text shown on the setup page for identity. */
  agentIntroText: string;
  /** Normalized 64-hex ED25519 public key (no private key, ever). */
  agentPublicKey: string;
  /** Vault funding in HBAR (validated 2–25 before this point). */
  budgetHbar: number;
}

export interface VaultPackageRecord extends VaultPackageInput {
  id: string;
  createdAt: number;
}

const KEY_PREFIX = "vault-package:";
const RL_PREFIX = "vault-package-rl:";
const TTL_MS = 24 * 3_600_000;
const RATE_LIMIT_TTL_MS = 24 * 3_600_000;
/** Max setup packages one agent key may create per 24h. */
export const VAULT_PACKAGE_DAILY_LIMIT = 3;
const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;

function keyFor(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

function validId(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id);
}

function validAgentKey(hex: string): boolean {
  return /^[0-9a-f]{64}$/.test(hex);
}

/**
 * Stash a vault setup package. Enforces the per-agent daily rate limit
 * (throws when exceeded). `store` is injectable for tests.
 */
export async function stashVaultPackage(
  input: VaultPackageInput,
  store: KvStore = getKvStore(),
): Promise<VaultPackageRecord> {
  const agentUsername = input.agentUsername.trim().toLowerCase();
  if (!USERNAME_RE.test(agentUsername)) {
    throw new Error("stashVaultPackage: bad agent username");
  }
  const agentIntroText = input.agentIntroText.trim().slice(0, 280);
  if (!agentIntroText) throw new Error("stashVaultPackage: intro text required");
  if (!validAgentKey(input.agentPublicKey)) {
    throw new Error("stashVaultPackage: bad agent public key");
  }
  if (
    !Number.isFinite(input.budgetHbar) ||
    input.budgetHbar < 0.1 ||
    input.budgetHbar > 25
  ) {
    throw new Error("stashVaultPackage: budget out of range");
  }

  // Per-agent rate limit — atomic incr, TTL from creation.
  const rlKey = `${RL_PREFIX}${input.agentPublicKey}`;
  let count: number;
  try {
    count = await store.incr(rlKey, RATE_LIMIT_TTL_MS);
  } catch {
    throw new Error("stashVaultPackage: temporarily unavailable — try again in a moment");
  }
  if (count > VAULT_PACKAGE_DAILY_LIMIT) {
    throw new Error(
      `stashVaultPackage: rate limited — one agent key may create ${VAULT_PACKAGE_DAILY_LIMIT} vault setups per day`,
    );
  }

  const record: VaultPackageRecord = {
    agentUsername,
    agentIntroText,
    agentPublicKey: input.agentPublicKey.toLowerCase(),
    budgetHbar: input.budgetHbar,
    id: randomBytes(16).toString("hex"),
    createdAt: Date.now(),
  };
  await store.set(keyFor(record.id), JSON.stringify(record), TTL_MS);
  return record;
}

/** The vault package for a short id, or null when unknown/expired. */
export async function getVaultPackage(
  id: string,
  store: KvStore = getKvStore(),
): Promise<VaultPackageRecord | null> {
  if (!validId(id)) return null;
  const raw = await store.get(keyFor(id));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as VaultPackageRecord;
    if (!p || p.id !== id || typeof p.agentUsername !== "string") return null;
    if (!validAgentKey(p.agentPublicKey)) return null;
    return p;
  } catch {
    return null;
  }
}

/** Delete a package — single-use: called at finalize, no replay. */
export async function deleteVaultPackage(
  id: string,
  store: KvStore = getKvStore(),
): Promise<void> {
  if (!validId(id)) return;
  await store.del(keyFor(id));
}
