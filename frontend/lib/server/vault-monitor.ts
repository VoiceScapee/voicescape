/**
 * vault-monitor — cron-friendly Agent Vault health monitoring (spec §4).
 *
 * Three queries, every 5 minutes, all $0 mirror-node REST:
 *  1. Key integrity: GET /api/v1/accounts/{vault} — the on-chain key set
 *     must equal the registered {human, agent} set (order-independent).
 *     Any deviation → immediate alert. A human-only key means "revoked"
 *     (the safe end-state); anything else means "key-changed" (hostile
 *     until proven otherwise).
 *  2. Activity scan: GET /api/v1/transactions?account.id={vault} with an
 *     EXACT-STRING timestamp cursor (never parseFloat — the float-rounding
 *     lesson). Flags CryptoUpdate, >50% outflows, and contract calls to
 *     contracts other than the Registry/Tips contracts.
 *  3. Balance floor: alert below ~1 HBAR ("vault low — top up or approvals
 *     will start failing"); 0 means empty.
 *
 * Two entry points:
 * - scanVault(...) — the cron path. Persists the cursor + last status.
 * - checkVaultHealth(...) — read-only (no persistence): backing for the
 *   `check_vault_health` MCP tool and the /v/manage dashboard. Works for
 *   unwatched vaults too (then the key check is "unverified").
 *
 * This module never signs, never spends, never sees private keys.
 */

import { getKvStore, type KvStore } from "./store";
import { canonicalKeyHex } from "./vault-keys";

/** Contracts the vault is expected to talk to. Anything else gets flagged. */
const REGISTRY_CONTRACT_ID = "0.0.10854058";
const TIPS_CONTRACT_ID = "0.0.10854060";
const KNOWN_CONTRACTS = new Set([REGISTRY_CONTRACT_ID, TIPS_CONTRACT_ID]);

const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";
const FETCH_TIMEOUT_MS = 10_000;
/** Below this the vault can't reliably pay for its next action. */
export const VAULT_LOW_BALANCE_HBAR = 1;

const WATCH_PREFIX = "vault-watch:";
const OWNER_PREFIX = "vault-owner:";
const WATCH_TTL_MS = 365 * 24 * 3_600_000; // watches persist; refreshed each scan

/** Index a vault under its human owner (for the /v/manage dashboard). */
export async function indexVaultOwner(
  humanAccountId: string,
  vaultId: string,
  store: KvStore = getKvStore(),
): Promise<void> {
  if (!/^0\.0\.\d+$/.test(humanAccountId) || !/^0\.0\.\d+$/.test(vaultId)) return;
  const key = `${OWNER_PREFIX}${humanAccountId}`;
  let list: string[] = [];
  try {
    const raw = await store.get(key);
    list = raw ? (JSON.parse(raw) as string[]) : [];
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
  if (!list.includes(vaultId)) {
    list.push(vaultId);
    await store.set(key, JSON.stringify(list.slice(-25)), WATCH_TTL_MS);
  }
}

/** Vault ids ever registered under a human account (newest last). */
export async function getVaultsForHuman(
  humanAccountId: string,
  store: KvStore = getKvStore(),
): Promise<string[]> {
  if (!/^0\.0\.\d+$/.test(humanAccountId)) return [];
  try {
    const raw = await store.get(`${OWNER_PREFIX}${humanAccountId}`);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(list) ? list.filter((v) => /^0\.0\.\d+$/.test(v)) : [];
  } catch {
    return [];
  }
}

export interface KeyRef {
  /** Canonical lowercase raw hex. */
  hex: string;
  keyType: string;
}

export interface VaultWatchRecord {
  vaultId: string;
  humanAccountId: string;
  humanKeyHex: string;
  humanKeyType: string;
  /** Null when watched without registration context (pasted id). */
  agentKeyHex: string | null;
  agentUsername: string | null;
  registeredAt: number;
  /** Exact consensus_timestamp string cursor — never a float. */
  cursor: string;
  lastScanAt: number | null;
  lastStatus: VaultStatus | null;
}

export type VaultStatus =
  | "healthy"
  | "revoked"
  | "key-changed"
  | "unverified"
  | "low-balance"
  | "empty"
  | "not-found"
  | "unknown";

export interface VaultHealth {
  vaultId: string;
  watched: boolean;
  status: VaultStatus;
  /** Plain-words status line for the human / agent. */
  statusDetail: string;
  balanceHbar: number | null;
  keyHealth: {
    expected: KeyRef[] | null;
    actual: KeyRef[] | null;
    /** Null when there is no registered expectation (unwatched). */
    match: boolean | null;
  };
  /** Machine-readable flags, e.g. "key-changed", "large-outflow". */
  flags: string[];
  lastScanAt: string | null;
  /** Plain-words next step. */
  guidance: string;
}

function watchKey(vaultId: string): string {
  return `${WATCH_PREFIX}${vaultId}`;
}

export interface RegisterWatchInput {
  vaultId: string;
  humanAccountId: string;
  humanKeyHex: string;
  humanKeyType: string;
  agentKeyHex: string | null;
  agentUsername: string | null;
}

/** Create (or refresh) a watch record. Throws on bad input. */
export async function registerVaultWatch(
  input: RegisterWatchInput,
  store: KvStore = getKvStore(),
): Promise<VaultWatchRecord> {
  if (!/^0\.0\.\d+$/.test(input.vaultId)) throw new Error("registerVaultWatch: bad vault id");
  if (!/^0\.0\.\d+$/.test(input.humanAccountId)) {
    throw new Error("registerVaultWatch: bad human account id");
  }
  if (!/^[0-9a-f]{64}$|^[0-9a-f]{66}$/.test(input.humanKeyHex)) {
    throw new Error("registerVaultWatch: bad human key hex");
  }
  if (input.agentKeyHex !== null && !/^[0-9a-f]{64}$/.test(input.agentKeyHex)) {
    throw new Error("registerVaultWatch: bad agent key hex");
  }
  const existing = await getVaultWatch(input.vaultId, store);
  const record: VaultWatchRecord = {
    vaultId: input.vaultId,
    humanAccountId: input.humanAccountId,
    humanKeyHex: input.humanKeyHex.toLowerCase(),
    humanKeyType: input.humanKeyType,
    agentKeyHex: input.agentKeyHex ? input.agentKeyHex.toLowerCase() : null,
    agentUsername: input.agentUsername,
    registeredAt: existing?.registeredAt ?? Date.now(),
    cursor: existing?.cursor ?? "0",
    lastScanAt: existing?.lastScanAt ?? null,
    lastStatus: existing?.lastStatus ?? null,
  };
  await store.set(watchKey(input.vaultId), JSON.stringify(record), WATCH_TTL_MS);
  await indexVaultOwner(input.humanAccountId, input.vaultId, store);
  await indexVaultGlobal(input.vaultId, store);
  return record;
}

/**
 * Global vault index — every watched vault id, for the scheduled scan.
 * (indexVaultOwner is per-human; the cron needs the full set.)
 */
const GLOBAL_INDEX_KEY = "vault-index:all";
const GLOBAL_INDEX_MAX = 5000;

async function indexVaultGlobal(vaultId: string, store: KvStore): Promise<void> {
  try {
    const raw = await store.get(GLOBAL_INDEX_KEY);
    let list: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    if (!Array.isArray(list)) list = [];
    if (!list.includes(vaultId)) {
      list.push(vaultId);
      await store.set(GLOBAL_INDEX_KEY, JSON.stringify(list.slice(-GLOBAL_INDEX_MAX)), WATCH_TTL_MS);
    }
  } catch {
    /* index is best-effort — the watch record itself is the source of truth */
  }
}

/** All watched vault ids (for the scheduled scan). Never throws. */
export async function getAllWatchedVaultIds(
  store: KvStore = getKvStore(),
): Promise<string[]> {
  try {
    const raw = await store.get(GLOBAL_INDEX_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(list) ? list.filter((v) => /^0\.0\.\d+$/.test(v)) : [];
  } catch {
    return [];
  }
}

export async function getVaultWatch(
  vaultId: string,
  store: KvStore = getKvStore(),
): Promise<VaultWatchRecord | null> {
  if (!/^0\.0\.\d+$/.test(vaultId)) return null;
  const raw = await store.get(watchKey(vaultId));
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as VaultWatchRecord;
    if (!r || r.vaultId !== vaultId) return null;
    return r;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Key-set parsing + comparison                                        */
/* ------------------------------------------------------------------ */

export interface MirrorKeyNode {
  _type?: string;
  key?: string | null;
  keys?: MirrorKeyNode[];
  threshold?: number;
}

/**
 * Flatten a mirror-node account key into canonical KeyRefs. Handles
 * simple keys and ThresholdKey/KeyList wrappers. Returns null for
 * hollow (null) or opaque keys.
 */
export function parseKeySet(node: MirrorKeyNode | null | undefined): KeyRef[] | null {
  if (!node || typeof node !== "object") return null;
  const type = (node._type ?? "").toUpperCase();
  if (type.includes("PROTOBUFENCODED")) return null;
  const subs = Array.isArray(node.keys) ? node.keys : null;
  if (subs || type.includes("THRESHOLD") || type.includes("KEYLIST")) {
    if (!subs) return null;
    const out: KeyRef[] = [];
    for (const s of subs) {
      const hex = canonicalKeyHex(s._type, s.key);
      if (!hex) return null; // one unreadable sub-key poisons the set
      out.push({ hex, keyType: (s._type ?? "unknown").toUpperCase() });
    }
    return out;
  }
  const hex = canonicalKeyHex(node._type, node.key);
  if (!hex) return null;
  return [{ hex, keyType: type }];
}

/** Order-independent set equality on canonical hex. */
export function keySetsEqual(a: KeyRef[], b: KeyRef[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a.map((k) => k.hex));
  const sb = new Set(b.map((k) => k.hex));
  if (sa.size !== sb.size) return false;
  for (const h of sa) if (!sb.has(h)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Mirror helpers                                                      */
/* ------------------------------------------------------------------ */

type FetchFn = typeof fetch;

async function fetchJson(
  fetchFn: FetchFn,
  url: string,
): Promise<{ ok: boolean; status: number; body: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

interface MirrorAccount {
  account: string;
  key: MirrorKeyNode | null;
  balance: { balance: number };
  deleted?: boolean;
}

async function fetchVaultAccount(
  fetchFn: FetchFn,
  vaultId: string,
): Promise<{ found: boolean; account: MirrorAccount | null }> {
  const { ok, status, body } = await fetchJson(fetchFn, `${MIRROR_BASE}/accounts/${vaultId}`);
  if (status === 404) return { found: false, account: null };
  if (!ok || !body || typeof body.account !== "string") return { found: true, account: null };
  return { found: true, account: body as MirrorAccount };
}

/* ------------------------------------------------------------------ */
/* Health evaluation (pure — shared by scan + read-only paths)         */
/* ------------------------------------------------------------------ */

interface EvalInput {
  vaultId: string;
  watch: VaultWatchRecord | null;
  account: MirrorAccount | null;
  found: boolean;
  recentFlags: string[];
}

function evaluateHealth(input: EvalInput): VaultHealth {
  const { vaultId, watch, account, found, recentFlags } = input;
  const base: Omit<VaultHealth, "status" | "statusDetail" | "guidance"> = {
    vaultId,
    watched: watch !== null,
    balanceHbar: null,
    keyHealth: { expected: null, actual: null, match: null },
    flags: [...recentFlags],
    lastScanAt: watch?.lastScanAt ? new Date(watch.lastScanAt).toISOString() : null,
  };

  if (!found) {
    return {
      ...base,
      status: "not-found",
      statusDetail: `Vault ${vaultId} doesn't exist on Hedera mainnet (or the mirror node hasn't seen it yet).`,
      guidance: "Check the account id. If it was just created, wait a minute and check again.",
    };
  }
  if (!account) {
    return {
      ...base,
      status: "unknown",
      statusDetail: "The mirror node didn't answer — try again in a moment.",
      guidance: "This is a network hiccup, not a vault problem. Retry the check.",
    };
  }

  const balanceHbar =
    typeof account.balance?.balance === "number" ? account.balance.balance / 100_000_000 : null;
  const actual = parseKeySet(account.key);

  let expected: KeyRef[] | null = null;
  let match: boolean | null = null;
  if (watch && watch.agentKeyHex) {
    expected = [
      { hex: watch.humanKeyHex, keyType: watch.humanKeyType },
      { hex: watch.agentKeyHex, keyType: "ED25519" },
    ];
    match = actual !== null && keySetsEqual(expected, actual);
  } else if (watch) {
    // Watched without registration context — nothing to compare against.
    match = null;
  }

  const health: VaultHealth = {
    ...base,
    balanceHbar,
    keyHealth: { expected, actual, match },
    status: "healthy",
    statusDetail: "",
    guidance: "",
  };

  // Status precedence: key-changed > revoked > empty > low-balance > healthy.
  // "unverified" applies when watched without a registered agent key.
  if (match === false && actual !== null) {
    const humanOnly =
      actual.length === 1 && actual[0].hex === watch!.humanKeyHex;
    if (humanOnly) {
      health.status = "revoked";
      health.statusDetail =
        "The vault key is human-only — the agent's access was revoked. " +
        "The agent's key is cryptographically dead: anything it tries now fails.";
      health.guidance =
        "This is the safe end-state after revoking. To give an agent access again, " +
        "create a fresh vault setup — never re-add a key you don't trust.";
      health.flags.push("revoked");
    } else {
      health.status = "key-changed";
      health.statusDetail =
        "CRITICAL: the vault's key changed to something unexpected — it no longer matches " +
        "the registered human + agent keys. Treat the agent side as hostile until proven otherwise.";
      health.guidance =
        "If you did NOT authorize this, revoke immediately from /v/manage — but if the " +
        "attacker rotated first, the vault may already be lost. Speed is everything: " +
        "open your wallet and sign the revocation now.";
      health.flags.push("key-changed");
    }
    return health;
  }

  if (balanceHbar !== null && balanceHbar <= 0) {
    health.status = "empty";
    health.statusDetail = "The vault is empty — the agent can't pay for anything until it's topped up.";
    health.guidance = `Send HBAR to ${vaultId} from your wallet to top it up.`;
    health.flags.push("empty");
    return health;
  }
  if (balanceHbar !== null && balanceHbar < VAULT_LOW_BALANCE_HBAR) {
    health.status = "low-balance";
    health.statusDetail =
      `The vault is low (${balanceHbar} HBAR) — below ~${VAULT_LOW_BALANCE_HBAR} HBAR, approvals will start failing.`;
    health.guidance = `Top up ${vaultId} from your wallet soon.`;
    health.flags.push("low-balance");
    return health;
  }

  // Unverified: no registered expectation to compare the key against.
  // (empty/low-balance are evaluated above so they still report first.)
  if (match === null) {
    const bal = balanceHbar !== null ? `${balanceHbar} HBAR` : "unknown";
    health.status = "unverified";
    health.statusDetail =
      `Vault ${vaultId}: balance ${bal}, no suspicious activity in recent transactions — ` +
      `but no agent key is registered for it, so the vault key itself can't be verified.`;
    health.guidance = watch
      ? "If this is your agent's vault, re-register it from the setup completion screen so the key check can verify it."
      : "If this is your agent's vault, register it for watching so key changes get flagged automatically.";
    return health;
  }

  health.statusDetail =
    `Vault ${vaultId} is healthy: key matches the registered human + agent pair` +
    (balanceHbar !== null ? `, balance ${balanceHbar} HBAR.` : ".");
  health.guidance = "Nothing to do. The agent can keep acting; you stay in your chat.";
  return health;
}

/* ------------------------------------------------------------------ */
/* Activity scan                                                       */
/* ------------------------------------------------------------------ */

interface ScanFlags {
  flags: string[];
  /** New exact-string cursor (last consensus_timestamp seen). */
  cursor: string;
}

/**
 * Scan transactions for suspicious activity. Pure fetch; persistence is
 * the caller's job (scanVault) so checkVaultHealth can reuse this
 * read-only. `mode: "since-cursor"` advances an exact-string cursor
 * (never parseFloat — the rounding loop); `mode: "recent"` just reads
 * the last N without moving anything.
 */
export async function scanActivity(
  fetchFn: FetchFn,
  vaultId: string,
  opts: { mode: "since-cursor"; cursor: string } | { mode: "recent"; limit?: number },
  balanceHbar: number | null,
): Promise<ScanFlags> {
  const flags: string[] = [];
  let newCursor = opts.mode === "since-cursor" ? opts.cursor : "0";
  const url =
    opts.mode === "since-cursor"
      ? `${MIRROR_BASE}/transactions?account.id=${vaultId}` +
        `&timestamp=gt:${encodeURIComponent(opts.cursor)}&order=asc&limit=100`
      : `${MIRROR_BASE}/transactions?account.id=${vaultId}&order=desc&limit=${opts.limit ?? 10}`;
  const { ok, body } = await fetchJson(fetchFn, url);
  if (!ok || !Array.isArray(body?.transactions)) return { flags, cursor: newCursor };

  for (const tx of body.transactions as Array<Record<string, any>>) {
    if (opts.mode === "since-cursor") {
      const ts = typeof tx.consensus_timestamp === "string" ? tx.consensus_timestamp : "";
      if (ts) newCursor = ts; // exact string — never parseFloat (rounding loop)
    }
    const name = typeof tx.name === "string" ? tx.name : "";

    if (name === "CryptoUpdate") {
      flags.push("key-or-account-updated-on-chain");
      continue;
    }
    if (name === "CryptoDelete") {
      flags.push("account-delete-attempted");
      continue;
    }
    if (name === "CryptoTransfer") {
      const transfers: Array<{ account: string; amount: number }> = Array.isArray(tx.transfers)
        ? tx.transfers
        : [];
      for (const t of transfers) {
        if (t.account === vaultId && t.amount < 0) {
          const outflowHbar = -t.amount / 100_000_000;
          if (balanceHbar !== null && balanceHbar > 0 && outflowHbar > balanceHbar * 0.5) {
            flags.push(`large-outflow:${outflowHbar.toFixed(2)}hbar`);
          }
        }
      }
      continue;
    }
    if (name === "ContractCall" || name === "ContractCreate") {
      const to = typeof tx.entity_id === "string" ? tx.entity_id : "";
      if (to && !KNOWN_CONTRACTS.has(to)) {
        flags.push(`contract-call-to-unknown:${to}`);
      }
    }
  }
  return { flags, cursor: newCursor };
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

/**
 * Cron path: full scan + persist cursor/status. Returns the health and
 * any NEW alerts (flags not seen in the previous scan are the caller's
 * signal to notify — compare with the stored record).
 */
export async function scanVault(
  vaultId: string,
  store: KvStore = getKvStore(),
  fetchFn: FetchFn = fetch,
): Promise<{ health: VaultHealth; alerts: string[] }> {
  const watch = await getVaultWatch(vaultId, store);
  const { found, account } = await fetchVaultAccount(fetchFn, vaultId);
  const balanceHbar =
    account && typeof account.balance?.balance === "number"
      ? account.balance.balance / 100_000_000
      : null;
  const { flags, cursor } = await scanActivity(
    fetchFn,
    vaultId,
    { mode: "since-cursor", cursor: watch?.cursor ?? "0" },
    balanceHbar,
  );
  const health = evaluateHealth({ vaultId, watch, account, found, recentFlags: flags });

  if (watch) {
    const updated: VaultWatchRecord = {
      ...watch,
      cursor,
      lastScanAt: Date.now(),
      lastStatus: health.status,
    };
    await store.set(watchKey(vaultId), JSON.stringify(updated), WATCH_TTL_MS);
  }
  // Alerts = flags + non-healthy status. The cron compares against the
  // previous lastStatus to decide what to actually send.
  const alerts = [...flags];
  if (health.status === "key-changed") alerts.unshift("ALERT:key-changed");
  if (health.status === "revoked") alerts.unshift("notice:revoked");
  if (health.status === "low-balance" || health.status === "empty") {
    alerts.unshift(`notice:${health.status}`);
  }
  return { health, alerts };
}

/**
 * Read-only health check — no persistence. Backs the `check_vault_health`
 * MCP tool and the /v/manage dashboard. For unwatched vaults the key
 * check is "unverified" but balance + recent activity still report.
 */
export async function checkVaultHealth(
  vaultId: string,
  store: KvStore = getKvStore(),
  fetchFn: FetchFn = fetch,
): Promise<VaultHealth> {
  if (!/^0\.0\.\d+$/.test(vaultId)) {
    return {
      vaultId,
      watched: false,
      status: "unknown",
      statusDetail: "Not a valid Hedera account id — expected 0.0.x.",
      balanceHbar: null,
      keyHealth: { expected: null, actual: null, match: null },
      flags: [],
      lastScanAt: null,
      guidance: "Pass the vault's 0.0.x account id.",
    };
  }
  const watch = await getVaultWatch(vaultId, store);
  const { found, account } = await fetchVaultAccount(fetchFn, vaultId);
  const balanceHbar =
    account && typeof account.balance?.balance === "number"
      ? account.balance.balance / 100_000_000
      : null;
  // Read-only: scan the last 10 txns (desc) without moving the cursor.
  const { flags } = await scanActivity(fetchFn, vaultId, { mode: "recent", limit: 10 }, balanceHbar);
  return evaluateHealth({ vaultId, watch, account, found, recentFlags: flags });
}
