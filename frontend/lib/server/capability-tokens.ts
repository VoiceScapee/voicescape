/**
 * capability-tokens — bearer credentials for keyless agents.
 *
 * A capability token is NOT a key: it cannot sign anything. v1 tokens only
 * let a keyless AI agent SUBMIT proposals (page content updates) to its
 * human's approval inbox. v2 (execution scopes) additionally lets the agent
 * ACT directly — but ONLY on server-side state, inside pre-approved walls:
 * setting its availability flag (availability:write) and staging page
 * drafts (draft:stage).
 *
 * Agents NEVER use the server's keys. Posting chat messages, signing, or
 * any chain write needs the agent's OWN Hedera key — see
 * prepare_agent_self_claim. A keyless agent's chat path is proposals with
 * a per-tap human approval.
 *
 * What execution scopes can NEVER do:
 * - Move funds, change ownership, or touch keys. Chain writes need a real
 *   key signature: the agent's own key, or the human's per-tap signature.
 * - Spend the human's money. (purchase:propose only asks for per-tap
 *   approval; the human signs the actual spend in their own wallet.)
 * - Publish a page change on-chain. draft:stage stages content for the
 *   human's review; the on-chain hash update still needs the human's key.
 *
 * Security properties:
 * - The raw token is shown ONCE at issuance and never stored. KV holds
 *   only the SHA-256 hash. A KV dump yields no usable credential.
 * - Validation is fail-closed: unknown / expired / revoked / wrong-scope
 *   tokens are rejected, and comparison is constant-time.
 * - Scope is an allow-list. Only the scopes in CAPABILITY_SCOPES exist;
 *   nothing else can be granted: page:update:propose, page:read, media:pin,
 *   availability:write, draft:stage, purchase:propose, review:propose.
 * - Revocation is instant: deleting the KV record makes the next attempt
 *   fail closed. There is no on-chain delegate to unwind because the
 *   server never holds any key on the human's account.
 * - v1 tokens expire after 30 days. v2 tokens do NOT expire by default
 *   (Brandon, 2026-10-08) — the human's ongoing controls are instant
 *   revocation, the daily rate limits, and the audit trail.
 * - Execution scopes are rate-limited per token per day, and every
 *   execution is audit-logged (append-only, human-readable).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getKvStore, type KvStore } from "./store";

/** The complete scope universe. Nothing else can be granted. */
export const CAPABILITY_SCOPES = [
  "page:update:propose",
  "page:read",
  "media:pin",
  "availability:write",
  "draft:stage",
  "purchase:propose",
  "review:propose",
] as const;
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];
/**
 * Default grant when no scopes are requested: the original three. The two
 * newer scopes (purchase:propose, review:propose) are never granted by
 * default — purchase in particular authorizes spending the human's money,
 * so it must always be explicitly requested.
 */
export const DEFAULT_CAPABILITY_SCOPES: CapabilityScope[] = [
  "page:update:propose",
  "page:read",
  "media:pin",
];

/** v1 token lifetime: 30 days. v2 tokens default to no expiry. */
export const TOKEN_TTL_MS = 30 * 24 * 3_600_000;
/** KV TTL for non-expiring records (finite — KV requires it). */
export const NO_EXPIRY_TTL_MS = 366 * 24 * 3_600_000;
/** Raw token prefix — identifiable, never secret by itself. */
const TOKEN_PREFIX = "vs_cap_";

/** Per-scope daily execution caps for the v2 execution scopes. */
export const SCOPE_DAILY_LIMITS: Partial<Record<CapabilityScope, number>> = {
  "availability:write": 10,
  "draft:stage": 10,
};

const KEY_BY_HASH = "cap-tokens:by-hash:";
const KEY_BY_ID = "cap-tokens:by-id:";
const KEY_BY_OWNER = "cap-tokens:by-owner:";
const KEY_AUDIT = "cap-tokens:audit:";
const KEY_RATELIMIT = "cap-tokens:ratelimit:";
const KEY_DRAFT = "cap-tokens:draft:";
/** Max audit entries kept per token (oldest dropped). */
const AUDIT_CAP = 200;

export interface CapabilityTokenRecord {
  /** Public handle (16 hex chars). Safe to log. */
  id: string;
  /** The human who issued it, "0.0.x". */
  ownerAccountId: string;
  /** SHA-256 hex of the raw token. Never the token itself. */
  tokenHash: string;
  scopes: CapabilityScope[];
  /** Human-given label, e.g. "Clawd's ops token". */
  label: string;
  createdAt: number;
  /** null = no expiry (v2 default). v1 tokens carry a timestamp. */
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  /** Token schema version: 1 = propose-only, 2 = execution scopes. */
  version: 1 | 2;
  /** The agent's own Hedera account, when it has one (allowance reference). */
  agentAccountId?: string;
}

export interface IssuedToken {
  /** The raw bearer token — shown ONCE. The caller must deliver it securely. */
  token: string;
  record: CapabilityTokenRecord;
}

export interface TokenAuditEntry {
  ts: number;
  action: string;
  detail: string;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function isScope(s: unknown): s is CapabilityScope {
  return typeof s === "string" && (CAPABILITY_SCOPES as readonly string[]).includes(s);
}

function normalizeOwner(ownerAccountId: string): string {
  const owner = (ownerAccountId ?? "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(owner)) throw new Error("capability-tokens: bad owner account id");
  return owner;
}

async function readOwnerIndex(owner: string, store: KvStore): Promise<string[]> {
  const raw = await store.get(KEY_BY_OWNER + owner);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function writeOwnerIndex(owner: string, ids: string[], store: KvStore, ttlMs: number): Promise<void> {
  if (ids.length === 0) {
    await store.del(KEY_BY_OWNER + owner);
    return;
  }
  await store.set(KEY_BY_OWNER + owner, JSON.stringify(ids), ttlMs);
}

/**
 * Issue a token. The human's session is the consent: callers must have
 * verified the human (e.g. via agentOwnerFromRequest) before calling.
 * Returns the raw token ONCE — it is never retrievable afterwards.
 *
 * v2 (execution scopes): pass version: 2, expiresAt: null for no expiry,
 * and optional agentAccountId. v1 behavior (30-day expiry,
 * propose-only) is preserved when version is omitted.
 */
export async function issueCapabilityToken(
  ownerAccountId: string,
  opts: {
    label: string;
    scopes?: CapabilityScope[];
    version?: 1 | 2;
    /** null = no expiry (v2 default). Omit = 30 days (v1 default). */
    expiresAt?: number | null;
    agentAccountId?: string;
  },
  store: KvStore = getKvStore(),
): Promise<IssuedToken> {
  const owner = normalizeOwner(ownerAccountId);
  const label = (opts.label ?? "").trim().slice(0, 80);
  if (!label) throw new Error("capability-tokens: label is required");
  const version = opts.version ?? 1;
  if (version !== 1 && version !== 2) throw new Error("capability-tokens: bad version");
  // v1 is the propose-only era: it cannot carry execution scopes.
  // purchase:propose/review:propose are propose-only (the human still signs),
  // so they belong to v1 alongside the original three.
  const V1_SCOPES = ["page:update:propose", "page:read", "media:pin", "purchase:propose", "review:propose"] as const;
  const scopes = opts.scopes ?? (version === 2 ? [...CAPABILITY_SCOPES] : [...V1_SCOPES]);
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(isScope)) {
    throw new Error("capability-tokens: scopes must be a non-empty subset of the known scopes");
  }
  if (version === 1 && !scopes.every((s) => (V1_SCOPES as readonly string[]).includes(s))) {
    throw new Error("capability-tokens: v1 tokens are propose-only — execution scopes need version 2");
  }

  let agentAccountId: string | undefined;
  if (opts.agentAccountId !== undefined) {
    const a = opts.agentAccountId.trim();
    if (!/^\d+\.\d+\.\d+$/.test(a)) throw new Error("capability-tokens: bad agent account id");
    agentAccountId = a;
  }
  const id = randomBytes(8).toString("hex");
  const raw = TOKEN_PREFIX + randomBytes(24).toString("hex");
  const now = Date.now();
  const expiresAt =
    opts.expiresAt === undefined
      ? version === 2
        ? null
        : now + TOKEN_TTL_MS
      : opts.expiresAt;
  const record: CapabilityTokenRecord = {
    id,
    ownerAccountId: owner,
    tokenHash: hashToken(raw),
    scopes: [...new Set(scopes)],
    label,
    createdAt: now,
    expiresAt,
    revokedAt: null,
    lastUsedAt: null,
    version,
    ...(agentAccountId ? { agentAccountId } : {}),
  };
  const ttlMs = record.expiresAt === null ? NO_EXPIRY_TTL_MS : Math.max(record.expiresAt - now, 1_000);
  await store.set(KEY_BY_HASH + record.tokenHash, JSON.stringify(record), ttlMs);
  await store.set(KEY_BY_ID + id, JSON.stringify(record), ttlMs);
  const ids = await readOwnerIndex(owner, store);
  ids.push(id);
  await writeOwnerIndex(owner, ids, store, ttlMs);
  await appendTokenAudit(id, { ts: now, action: "issued", detail: `v${version} token issued (${record.scopes.length} scopes${record.expiresAt === null ? ", no expiry" : ""})` }, store);
  return { token: raw, record };
}

/** True when the record is live right now (not revoked, not expired). */
function isLive(rec: CapabilityTokenRecord): boolean {
  if (rec.revokedAt !== null) return false;
  if (rec.expiresAt !== null && Date.now() >= rec.expiresAt) return false;
  return true;
}

export interface ValidatedToken {
  record: CapabilityTokenRecord;
}

/**
 * Validate a presented bearer token for a required scope. Fail-closed:
 * anything unexpected → null. On success, touches lastUsedAt (best-effort).
 */
export async function validateCapabilityToken(
  rawToken: unknown,
  requiredScope: CapabilityScope,
  store: KvStore = getKvStore(),
): Promise<ValidatedToken | null> {
  if (typeof rawToken !== "string" || !rawToken.startsWith(TOKEN_PREFIX)) return null;
  const secret = rawToken.slice(TOKEN_PREFIX.length);
  if (!/^[0-9a-f]{48}$/.test(secret)) return null;
  if (!isScope(requiredScope)) return null;

  const stored = await readByHash(rawToken, store);
  if (!stored) return null;
  if (!isLive(stored)) return null;
  if (!Array.isArray(stored.scopes) || !stored.scopes.includes(requiredScope)) return null;

  await touchUsage(stored, store);
  return { record: stored };
}

/**
 * Validate a token without requiring a specific scope — for read-only
 * introspection (check_grant_status). Still fail-closed on unknown /
 * revoked / expired.
 */
export async function validateCapabilityTokenLive(
  rawToken: unknown,
  store: KvStore = getKvStore(),
): Promise<ValidatedToken | null> {
  if (typeof rawToken !== "string" || !rawToken.startsWith(TOKEN_PREFIX)) return null;
  const secret = rawToken.slice(TOKEN_PREFIX.length);
  if (!/^[0-9a-f]{48}$/.test(secret)) return null;
  const stored = await readByHash(rawToken, store);
  if (!stored) return null;
  if (!isLive(stored)) return null;
  await touchUsage(stored, store);
  return { record: stored };
}

async function readByHash(rawToken: string, store: KvStore): Promise<CapabilityTokenRecord | null> {
  const presentedHash = hashToken(rawToken);
  try {
    const raw = await store.get(KEY_BY_HASH + presentedHash);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CapabilityTokenRecord;
    // Constant-time compare of the hashes (both 64-hex → 32 bytes).
    const a = Buffer.from(presentedHash, "hex");
    const b = Buffer.from(parsed.tokenHash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function ttlFor(rec: CapabilityTokenRecord): number {
  return rec.expiresAt === null ? NO_EXPIRY_TTL_MS : Math.max(rec.expiresAt - Date.now(), 1_000);
}

async function touchUsage(stored: CapabilityTokenRecord, store: KvStore): Promise<void> {
  // Best-effort usage touch — never blocks validation.
  try {
    stored.lastUsedAt = Date.now();
    const body = JSON.stringify(stored);
    const ttlMs = ttlFor(stored);
    await store.set(KEY_BY_HASH + stored.tokenHash, body, ttlMs);
    await store.set(KEY_BY_ID + stored.id, body, ttlMs);
  } catch {
    /* usage tracking never blocks */
  }
}

/** The human's tokens (metadata only — raw tokens are never retrievable). */
export async function listCapabilityTokens(
  ownerAccountId: string,
  store: KvStore = getKvStore(),
): Promise<CapabilityTokenRecord[]> {
  const owner = normalizeOwner(ownerAccountId);
  const ids = await readOwnerIndex(owner, store);
  const out: CapabilityTokenRecord[] = [];
  for (const id of ids) {
    try {
      const raw = await store.get(KEY_BY_ID + id);
      if (!raw) continue;
      const rec = JSON.parse(raw) as CapabilityTokenRecord;
      if (!isLive(rec)) continue;
      out.push(rec);
    } catch {
      /* skip unreadable entries */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Revoke a token by id. Instant: the next validation fails closed.
 * Returns true when a live token was revoked.
 */
export async function revokeCapabilityToken(
  ownerAccountId: string,
  tokenId: string,
  store: KvStore = getKvStore(),
): Promise<boolean> {
  const owner = normalizeOwner(ownerAccountId);
  const id = (tokenId ?? "").trim();
  if (!/^[0-9a-f]{16}$/.test(id)) return false;
  let rec: CapabilityTokenRecord | null = null;
  try {
    const raw = await store.get(KEY_BY_ID + id);
    if (!raw) return false;
    rec = JSON.parse(raw) as CapabilityTokenRecord;
  } catch {
    return false;
  }
  if (!rec || rec.ownerAccountId !== owner) return false;
  if (rec.revokedAt !== null) return false;
  await store.del(KEY_BY_HASH + rec.tokenHash);
  await store.del(KEY_BY_ID + id);
  const ids = await readOwnerIndex(owner, store);
  await writeOwnerIndex(
    owner,
    ids.filter((x) => x !== id),
    store,
    ttlFor(rec),
  );
  await appendTokenAudit(id, { ts: Date.now(), action: "revoked", detail: "revoked by the human" }, store);
  return true;
}

/* ------------------------------------------------------------------ */
/* Audit log — append-only, human-readable, per token                   */
/* ------------------------------------------------------------------ */

/** Append an audit entry. Best-effort: never throws. */
export async function appendTokenAudit(
  tokenId: string,
  entry: TokenAuditEntry,
  store: KvStore = getKvStore(),
): Promise<void> {
  try {
    const id = (tokenId ?? "").trim();
    if (!/^[0-9a-f]{16}$/.test(id)) return;
    const key = KEY_AUDIT + id;
    const raw = await store.get(key);
    let entries: TokenAuditEntry[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) entries = parsed.filter(isAuditEntry);
      } catch {
        entries = [];
      }
    }
    entries.push({
      ts: typeof entry.ts === "number" ? entry.ts : Date.now(),
      action: String(entry.action ?? "").slice(0, 40),
      detail: String(entry.detail ?? "").slice(0, 500),
    });
    if (entries.length > AUDIT_CAP) entries = entries.slice(entries.length - AUDIT_CAP);
    await store.set(key, JSON.stringify(entries), NO_EXPIRY_TTL_MS);
  } catch {
    /* audit never blocks */
  }
}

function isAuditEntry(x: unknown): x is TokenAuditEntry {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as { ts?: unknown }).ts === "number" &&
    typeof (x as { action?: unknown }).action === "string"
  );
}

/** Read the audit trail, newest last. Empty array when none. */
export async function readTokenAudit(
  tokenId: string,
  store: KvStore = getKvStore(),
): Promise<TokenAuditEntry[]> {
  try {
    const id = (tokenId ?? "").trim();
    if (!/^[0-9a-f]{16}$/.test(id)) return [];
    const raw = await store.get(KEY_AUDIT + id);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isAuditEntry) : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Per-scope daily rate limits (v2 execution scopes)                   */
/* ------------------------------------------------------------------ */

function rateLimitKey(tokenHash: string, scope: CapabilityScope, day: string): string {
  return `${KEY_RATELIMIT}${tokenHash}:${scope}:${day}`;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Check AND consume one unit of a scope's daily budget. Returns the
 * remaining budget after this call, or null when the scope has no limit
 * or the budget is exhausted. Fail-closed on store errors for limited
 * scopes (a broken counter must not become unlimited).
 */
export async function consumeScopeBudget(
  tokenHash: string,
  scope: CapabilityScope,
  store: KvStore = getKvStore(),
): Promise<number | null> {
  const limit = SCOPE_DAILY_LIMITS[scope];
  if (limit === undefined) return null; // no limit for this scope
  const key = rateLimitKey(tokenHash, scope, utcDay());
  try {
    const raw = await store.get(key);
    const used = raw ? parseInt(raw, 10) : 0;
    if (!Number.isFinite(used) || used < 0) {
      await store.set(key, "1", 24 * 3_600_000);
      return limit - 1;
    }
    if (used >= limit) return 0; // exhausted — 0 remaining
    await store.set(key, String(used + 1), 24 * 3_600_000);
    return limit - (used + 1);
  } catch {
    return 0; // fail closed: treat store failure as exhausted
  }
}

/** Remaining daily budget for a scope without consuming. */
export async function remainingScopeBudget(
  tokenHash: string,
  scope: CapabilityScope,
  store: KvStore = getKvStore(),
): Promise<number | null> {
  const limit = SCOPE_DAILY_LIMITS[scope];
  if (limit === undefined) return null;
  try {
    const raw = await store.get(rateLimitKey(tokenHash, scope, utcDay()));
    const used = raw ? parseInt(raw, 10) : 0;
    if (!Number.isFinite(used) || used < 0) return limit;
    return Math.max(0, limit - used);
  } catch {
    return 0;
  }
}


/* ------------------------------------------------------------------ */
/* Staged page drafts (draft:stage scope)                               */
/* ------------------------------------------------------------------ */

export interface StagedDraft {
  username: string;
  tokenId: string;
  changeSummary: string;
  content: string;
  stagedAt: number;
}

/**
 * Stage a page draft for the human's review. Publishing still needs the
 * human's key — staging is not publishing. One draft per username (latest
 * wins).
 */
export async function stageDraft(
  username: string,
  tokenId: string,
  changeSummary: string,
  content: string,
  store: KvStore = getKvStore(),
): Promise<StagedDraft> {
  const draft: StagedDraft = {
    username,
    tokenId,
    changeSummary: changeSummary.slice(0, 500),
    content: content.slice(0, 200_000),
    stagedAt: Date.now(),
  };
  await store.set(KEY_DRAFT + username, JSON.stringify(draft), NO_EXPIRY_TTL_MS);
  return draft;
}

/** Read the staged draft for a username, or null. */
export async function readDraft(
  username: string,
  store: KvStore = getKvStore(),
): Promise<StagedDraft | null> {
  try {
    const raw = await store.get(KEY_DRAFT + username);
    if (!raw) return null;
    const d = JSON.parse(raw) as StagedDraft;
    if (!d || d.username !== username || typeof d.content !== "string") return null;
    return d;
  } catch {
    return null;
  }
}
