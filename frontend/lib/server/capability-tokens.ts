/**
 * capability-tokens — bearer credentials for keyless agents.
 *
 * A capability token is NOT a key: it cannot sign anything. It only lets a
 * keyless AI agent SUBMIT proposals (page content updates) to its human's
 * approval inbox. Every on-chain write still requires the human's own
 * wallet signature — the token authorizes requests, never executions.
 *
 * Security properties:
 * - The raw token is shown ONCE at issuance and never stored. KV holds
 *   only the SHA-256 hash. A KV dump yields no usable credential.
 * - Validation is fail-closed: unknown / expired / revoked / wrong-scope
 *   tokens are rejected, and comparison is constant-time.
 * - Scope is an allow-list. Only three scopes exist; nothing else can be
 *   granted: page:update:propose, page:read, media:pin.
 * - Revocation is instant: deleting the KV record makes the next attempt
 *   fail closed. There is no on-chain delegate to unwind because the
 *   server never holds any key on the human's account.
 * - Tokens expire after 30 days and are rotatable (issue new, revoke old).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getKvStore, type KvStore } from "./store";

/** The complete scope universe. Nothing else can be granted. */
export const CAPABILITY_SCOPES = ["page:update:propose", "page:read", "media:pin"] as const;
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

/** Token lifetime: 30 days. */
export const TOKEN_TTL_MS = 30 * 24 * 3_600_000;
/** Raw token prefix — identifiable, never secret by itself. */
const TOKEN_PREFIX = "vs_cap_";

const KEY_BY_HASH = "cap-tokens:by-hash:";
const KEY_BY_ID = "cap-tokens:by-id:";
const KEY_BY_OWNER = "cap-tokens:by-owner:";

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
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface IssuedToken {
  /** The raw bearer token — shown ONCE. The caller must deliver it securely. */
  token: string;
  record: CapabilityTokenRecord;
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
 */
export async function issueCapabilityToken(
  ownerAccountId: string,
  opts: { label: string; scopes?: CapabilityScope[] },
  store: KvStore = getKvStore(),
): Promise<IssuedToken> {
  const owner = normalizeOwner(ownerAccountId);
  const label = (opts.label ?? "").trim().slice(0, 80);
  if (!label) throw new Error("capability-tokens: label is required");
  const scopes = opts.scopes ?? [...CAPABILITY_SCOPES];
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(isScope)) {
    throw new Error("capability-tokens: scopes must be a non-empty subset of the known scopes");
  }

  const id = randomBytes(8).toString("hex");
  const raw = TOKEN_PREFIX + randomBytes(24).toString("hex");
  const now = Date.now();
  const record: CapabilityTokenRecord = {
    id,
    ownerAccountId: owner,
    tokenHash: hashToken(raw),
    scopes: [...new Set(scopes)],
    label,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS,
    revokedAt: null,
    lastUsedAt: null,
  };
  const ttlMs = Math.max(record.expiresAt - now, 1_000);
  await store.set(KEY_BY_HASH + record.tokenHash, JSON.stringify(record), ttlMs);
  await store.set(KEY_BY_ID + id, JSON.stringify(record), ttlMs);
  const ids = await readOwnerIndex(owner, store);
  ids.push(id);
  await writeOwnerIndex(owner, ids, store, ttlMs);
  return { token: raw, record };
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

  const presentedHash = hashToken(rawToken);
  let stored: CapabilityTokenRecord | null = null;
  try {
    const raw = await store.get(KEY_BY_HASH + presentedHash);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CapabilityTokenRecord;
    // Constant-time compare of the hashes (both 64-hex → 32 bytes).
    const a = Buffer.from(presentedHash, "hex");
    const b = Buffer.from(parsed.tokenHash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    stored = parsed;
  } catch {
    return null;
  }
  if (stored.revokedAt !== null) return null;
  if (Date.now() >= stored.expiresAt) return null;
  if (!Array.isArray(stored.scopes) || !stored.scopes.includes(requiredScope)) return null;

  // Best-effort usage touch — never blocks validation.
  try {
    stored.lastUsedAt = Date.now();
    const ttlMs = Math.max(stored.expiresAt - Date.now(), 1_000);
    const body = JSON.stringify(stored);
    await store.set(KEY_BY_HASH + stored.tokenHash, body, ttlMs);
    await store.set(KEY_BY_ID + stored.id, body, ttlMs);
  } catch {
    /* usage tracking never blocks */
  }
  return { record: stored };
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
      if (rec.revokedAt !== null || Date.now() >= rec.expiresAt) continue;
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
    Math.max(rec.expiresAt - Date.now(), 1_000),
  );
  return true;
}
