/**
 * Voicescape agent links + agent API keys (server-only).
 *
 * The human-facing connection layer for AI agents:
 *
 *  1. A signed-in human links their AI agent's Hedera account (0.0.x) by
 *     signing ONE link message with their wallet
 *     (see @/lib/agent-link-message). The server verifies the signature
 *     cryptographically and records: user wallet ↔ agent account id ↔
 *     agent's Voicescape username.
 *  2. On link, the server issues a long-lived, revocable, scoped API key
 *     for the agent. Only the SHA-256 hash is stored; the plaintext is
 *     shown exactly once. The agent sends it as `x-vs-agent-key` instead
 *     of a wallet session on /api/agents/execute.
 *
 * Money model (unchanged): the agent transacts from its OWN funded Hedera
 * wallet — the server only ever returns unsigned transaction bytes, which
 * the agent signs with its own key. The server never holds private keys.
 * No PII is stored: wallet addresses and account ids only.
 *
 * Safety: every key-authenticated request still goes through the executor's
 * content filter and the 100 HBAR per-operation cap, plus a per-key quota
 * (30/hour) in front of the per-IP flood gate.
 */

import { createHash, randomBytes } from "crypto";
import {
  AGENT_KEY_HEADER,
  AGENT_KEY_PREFIX,
  parseLinkMessage,
  type LinkMessageFields,
} from "@/lib/agent-link-message";
import {
  canonicalAddress,
  hexToBytes,
  isHederaAccountId,
  verifyEvmSignature,
  CLOCK_SKEW_MS,
} from "@/lib/session-message";
import {
  hederaSignedMessageBytes,
  requireAppOrigin,
  verifyEcdsaSecp256k1,
  verifyEd25519,
  type AccountKey,
} from "@/lib/server/townhall/auth";
import { mirrorBaseUrl } from "@/lib/server/townhall/topics";
import type { KvStore } from "@/lib/server/store";

export { AGENT_KEY_HEADER, AGENT_KEY_PREFIX };

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Link signatures stay valid for 10 minutes after signing. */
export const LINK_MESSAGE_TTL_MS = 10 * 60 * 1000;
/** Link records slide-expire after ~13 months of disuse. */
export const LINK_RECORD_TTL_MS = 400 * 24 * 3600 * 1000;
/** Per-key quota: executions per hour per agent API key. */
export const AGENT_KEY_RATE_LIMIT = 30;
export const AGENT_KEY_RATE_WINDOW_MS = 60 * 60 * 1000;
/** Randomness in each issued key (48 hex chars after the prefix). */
const AGENT_KEY_RANDOM_BYTES = 24;

/* ------------------------------------------------------------------ */
/* Link message validation                                             */
/* ------------------------------------------------------------------ */

export interface ValidateLinkOpts {
  /** Canonical session address (0x lowercase) of the signer. */
  expectedUserAddress: string;
  /** Agent account id the request claims to link (0.0.x). */
  expectedAgentAccountId: string;
  /** Origin the message must be addressed to; null skips the check (dev). */
  expectedOrigin: string | null;
  nowMs?: number;
}

export type ValidateLinkResult =
  | { ok: true; fields: LinkMessageFields }
  | { ok: false; error: string };

export function validateLinkMessage(
  message: string,
  opts: ValidateLinkOpts,
): ValidateLinkResult {
  const fields = parseLinkMessage(message);
  if (!fields) return { ok: false, error: "malformed link message" };
  if (canonicalAddress(fields.userAddress) !== canonicalAddress(opts.expectedUserAddress)) {
    return { ok: false, error: "link message is not addressed to this wallet" };
  }
  if (fields.agentAccountId !== opts.expectedAgentAccountId) {
    return { ok: false, error: "link message names a different agent account" };
  }
  if (opts.expectedOrigin) {
    const norm = (u: string) => u.replace(/\/+$/, "");
    if (norm(fields.uri) !== norm(opts.expectedOrigin)) {
      return { ok: false, error: "link message is addressed to a different site" };
    }
  }
  const nowMs = opts.nowMs ?? Date.now();
  const issuedAtMs = Date.parse(fields.issuedAt);
  if (issuedAtMs > nowMs + CLOCK_SKEW_MS) {
    return { ok: false, error: "link message timestamp is in the future" };
  }
  if (nowMs - issuedAtMs > LINK_MESSAGE_TTL_MS) {
    return { ok: false, error: "link message expired — sign a fresh one and try again" };
  }
  return { ok: true, fields };
}

/* ------------------------------------------------------------------ */
/* Link signature verification                                         */
/* ------------------------------------------------------------------ */

export type FetchAccountKey = (accountId: string) => Promise<AccountKey | null>;

/** Mirror-node public-key lookup — same shape as the login flow's. */
async function fetchLinkAccountKey(accountId: string): Promise<AccountKey | null> {
  let res: Response;
  try {
    res = await fetch(`${mirrorBaseUrl()}/api/v1/accounts/${encodeURIComponent(accountId)}`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json: { key?: { _type?: string; key?: string } };
  try {
    json = (await res.json()) as { key?: { _type?: string; key?: string } };
  } catch {
    return null;
  }
  const keyHex = json.key?.key;
  if (!keyHex || !/^[0-9a-fA-F]+$/.test(keyHex)) return null;
  return { keyHex, keyType: json.key?._type ?? "UNKNOWN" };
}

function hexBytes(hex: string): Uint8Array | null {
  try {
    return hexToBytes(hex.replace(/^0x/i, ""));
  } catch {
    return null;
  }
}

/**
 * Verify that `signature` over `message` was made by `userAddress`'s key.
 * EVM: personal_sign recovery. Hedera: mirror-node public key, Ed25519 or
 * ECDSA(secp256k1), accepting the "\x19Hedera Signed Message:" prefixed
 * bytes or the raw message bytes — the same acceptance set as sign-in.
 */
export async function verifyLinkSignature(
  message: string,
  signature: string,
  userAddress: string,
  fetchAccountKey: FetchAccountKey = fetchLinkAccountKey,
): Promise<boolean> {
  const canonical = canonicalAddress(userAddress);
  if (!canonical) return false;
  if (!isHederaAccountId(userAddress)) {
    return verifyEvmSignature(message, signature, canonical);
  }
  const key = await fetchAccountKey(userAddress);
  if (!key) return false;
  const sigBytes = hexBytes(signature);
  const keyBytes = hexBytes(key.keyHex);
  if (!sigBytes || !keyBytes) return false;
  const msgBytes = new TextEncoder().encode(message);
  const prefixed = hederaSignedMessageBytes(message);
  const keyType = (key.keyType ?? "").toUpperCase();
  if (keyType === "ED25519") {
    return (
      verifyEd25519(prefixed, sigBytes, keyBytes) ||
      verifyEd25519(msgBytes, sigBytes, keyBytes)
    );
  }
  if (keyType === "ECDSA_SECP256K1" || keyType === "ECDSA") {
    return (
      verifyEcdsaSecp256k1(prefixed, sigBytes, keyBytes) ||
      verifyEcdsaSecp256k1(msgBytes, sigBytes, keyBytes)
    );
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* API key issuance                                                    */
/* ------------------------------------------------------------------ */

export interface IssuedAgentKey {
  /** Plaintext key — shown to the user exactly once, never stored. */
  key: string;
  /** SHA-256 hex of the key — what the server stores and looks up. */
  keyHash: string;
  /** Short id for display/support (first 12 hex chars of the hash). */
  keyId: string;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function issueAgentKey(): IssuedAgentKey {
  const key = AGENT_KEY_PREFIX + randomBytes(AGENT_KEY_RANDOM_BYTES).toString("hex");
  const keyHash = sha256Hex(key);
  return { key, keyHash, keyId: keyHash.slice(0, 12) };
}

/* ------------------------------------------------------------------ */
/* Link records (KV store)                                             */
/* ------------------------------------------------------------------ */

export interface AgentLinkRecord {
  /** Canonical 0x address (lowercase) of the linking human wallet. */
  userAddress: string;
  /** Address as written at link time (0.0.x or 0x…). */
  userAddressDisplay: string;
  /** The agent's Hedera account id (0.0.x) — the transaction payer. */
  agentAccountId: string;
  /** The agent's Voicescape username (verified at link time). */
  username: string;
  keyId: string;
  /** SHA-256 of the agent API key. The plaintext key is never stored. */
  keyHash: string;
  createdAtMs: number;
  revokedAtMs: number | null;
}

/** What the API and UI may see — never the key hash. */
export interface PublicAgentLink {
  userAddressDisplay: string;
  agentAccountId: string;
  username: string;
  keyId: string;
  /** Masked hint, e.g. "vsak_••••a1b2". */
  keyHint: string;
  createdAtMs: number;
  revokedAtMs: number | null;
}

export function publicLink(r: AgentLinkRecord): PublicAgentLink {
  return {
    userAddressDisplay: r.userAddressDisplay,
    agentAccountId: r.agentAccountId,
    username: r.username,
    keyId: r.keyId,
    keyHint: `${AGENT_KEY_PREFIX}••••${r.keyHash.slice(-4)}`,
    createdAtMs: r.createdAtMs,
    revokedAtMs: r.revokedAtMs,
  };
}

const linkKey = (userAddress: string, agentAccountId: string) =>
  `agent-link:${userAddress.toLowerCase()}:${agentAccountId}`;
const keyLookupKey = (keyHash: string) => `agent-key:${keyHash}`;
const indexKey = (userAddress: string) => `agent-link-index:${userAddress.toLowerCase()}`;
const quotaKey = (keyHash: string) => `agent-key-quota:${keyHash}`;
const nonceKey = (nonce: string) => `agent-link-nonce:${nonce}`;

function parseRecord(raw: string | null): AgentLinkRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as AgentLinkRecord;
    if (!r || typeof r.agentAccountId !== "string" || typeof r.keyHash !== "string") return null;
    return r;
  } catch {
    return null;
  }
}

async function readIndex(store: KvStore, userAddress: string): Promise<string[]> {
  const raw = await store.get(indexKey(userAddress));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface CreateLinkInput {
  /** Canonical session address (0x lowercase). */
  userAddress: string;
  userAddressDisplay: string;
  agentAccountId: string;
  username: string;
  nowMs?: number;
}

export type CreateLinkResult =
  | { ok: true; link: PublicAgentLink; apiKey: string }
  | { ok: false; error: string };

/**
 * Record a new link and issue its API key. Refuses when an active link
 * already exists for this pair (use rotate instead). The plaintext key is
 * returned once — the caller must show it to the user immediately.
 */
export async function createAgentLink(
  store: KvStore,
  input: CreateLinkInput,
): Promise<CreateLinkResult> {
  const nowMs = input.nowMs ?? Date.now();
  const existing = await getAgentLink(store, input.userAddress, input.agentAccountId);
  if (existing && !existing.revokedAtMs) {
    return { ok: false, error: "this agent is already linked — revoke or rotate its key instead" };
  }
  const issued = issueAgentKey();
  const record: AgentLinkRecord = {
    userAddress: input.userAddress.toLowerCase(),
    userAddressDisplay: input.userAddressDisplay,
    agentAccountId: input.agentAccountId,
    username: input.username,
    keyId: issued.keyId,
    keyHash: issued.keyHash,
    createdAtMs: nowMs,
    revokedAtMs: null,
  };
  const raw = JSON.stringify(record);
  await store.set(linkKey(record.userAddress, record.agentAccountId), raw, LINK_RECORD_TTL_MS);
  await store.set(keyLookupKey(issued.keyHash), raw, LINK_RECORD_TTL_MS);
  const idx = await readIndex(store, record.userAddress);
  if (!idx.includes(record.agentAccountId)) {
    idx.push(record.agentAccountId);
    await store.set(indexKey(record.userAddress), JSON.stringify(idx), LINK_RECORD_TTL_MS);
  }
  return { ok: true, link: publicLink(record), apiKey: issued.key };
}

export async function getAgentLink(
  store: KvStore,
  userAddress: string,
  agentAccountId: string,
): Promise<AgentLinkRecord | null> {
  return parseRecord(await store.get(linkKey(userAddress, agentAccountId)));
}

export async function listAgentLinks(
  store: KvStore,
  userAddress: string,
): Promise<PublicAgentLink[]> {
  const ids = await readIndex(store, userAddress);
  const out: PublicAgentLink[] = [];
  for (const id of ids) {
    const r = await getAgentLink(store, userAddress, id);
    if (r) out.push(publicLink(r));
  }
  return out;
}

/**
 * Look up a link by presented key hash. Refreshes the sliding TTL so
 * actively used keys don't expire. Returns null for unknown keys.
 */
export async function getLinkByKeyHash(
  store: KvStore,
  keyHash: string,
): Promise<AgentLinkRecord | null> {
  const record = parseRecord(await store.get(keyLookupKey(keyHash)));
  if (!record) return null;
  const raw = JSON.stringify(record);
  await store.set(linkKey(record.userAddress, record.agentAccountId), raw, LINK_RECORD_TTL_MS);
  await store.set(keyLookupKey(keyHash), raw, LINK_RECORD_TTL_MS);
  return record;
}

/** Revoke a link: the API key stops working immediately. */
export async function revokeAgentLink(
  store: KvStore,
  userAddress: string,
  agentAccountId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const record = await getAgentLink(store, userAddress, agentAccountId);
  if (!record || record.revokedAtMs) return false;
  record.revokedAtMs = nowMs;
  const raw = JSON.stringify(record);
  await store.set(linkKey(record.userAddress, record.agentAccountId), raw, LINK_RECORD_TTL_MS);
  await store.set(keyLookupKey(record.keyHash), raw, LINK_RECORD_TTL_MS);
  return true;
}

export type RotateKeyResult =
  | { ok: true; link: PublicAgentLink; apiKey: string }
  | { ok: false; error: string };

/**
 * Issue a fresh API key for an existing link. The old key stops working
 * immediately (its lookup entry is deleted).
 */
export async function rotateAgentKey(
  store: KvStore,
  userAddress: string,
  agentAccountId: string,
  nowMs: number = Date.now(),
): Promise<RotateKeyResult> {
  const record = await getAgentLink(store, userAddress, agentAccountId);
  if (!record || record.revokedAtMs) {
    return { ok: false, error: "no active link for this agent" };
  }
  const oldHash = record.keyHash;
  const issued = issueAgentKey();
  record.keyHash = issued.keyHash;
  record.keyId = issued.keyId;
  const raw = JSON.stringify(record);
  await store.set(linkKey(record.userAddress, record.agentAccountId), raw, LINK_RECORD_TTL_MS);
  await store.set(keyLookupKey(issued.keyHash), raw, LINK_RECORD_TTL_MS);
  await store.del(keyLookupKey(oldHash));
  void nowMs;
  return { ok: true, link: publicLink(record), apiKey: issued.key };
}

/** Single-use claim for link-message nonces (replay protection). */
export async function claimLinkNonce(store: KvStore, nonce: string): Promise<boolean> {
  return store.setNx(nonceKey(nonce), "1", LINK_MESSAGE_TTL_MS + 60_000);
}

/** Per-key quota check. Throws when the store is unreachable (fail closed). */
export async function checkAgentKeyQuota(
  store: KvStore,
  keyHash: string,
): Promise<{ ok: boolean; used: number }> {
  const used = await store.incr(quotaKey(keyHash), AGENT_KEY_RATE_WINDOW_MS);
  return { ok: used <= AGENT_KEY_RATE_LIMIT, used };
}

/* ------------------------------------------------------------------ */
/* Agent-key authentication for /api/agents/execute                    */
/* ------------------------------------------------------------------ */

export interface AgentKeyIdentity {
  /** Canonical 0x address (lowercase) of the linking human wallet. */
  userAddress: string;
  /** The agent's Hedera account id (0.0.x) — the transaction payer. */
  agentAccountId: string;
  /** The agent's Voicescape username (verified at link time). */
  username: string;
  keyId: string;
}

export type AgentKeyAuthResult =
  | { ok: true; identity: AgentKeyIdentity }
  | { ok: false; error: string; status: 401 | 429 | 503 };

/**
 * Authenticate an agent request from the `x-vs-agent-key` header.
 * Returns the linked identity; the caller must additionally require that
 * the request's agentId matches identity.username.
 */
export async function resolveAgentKeyAuth(
  headers: Headers,
  store: KvStore,
): Promise<AgentKeyAuthResult> {
  const presented = headers.get(AGENT_KEY_HEADER)?.trim();
  if (!presented) {
    return { ok: false, error: "missing agent key", status: 401 };
  }
  if (!presented.startsWith(AGENT_KEY_PREFIX) || presented.length < AGENT_KEY_PREFIX.length + 16) {
    return { ok: false, error: "malformed agent key", status: 401 };
  }
  const keyHash = sha256Hex(presented);
  let record: AgentLinkRecord | null;
  try {
    record = await getLinkByKeyHash(store, keyHash);
  } catch {
    return { ok: false, error: "key store unavailable — try again in a moment", status: 503 };
  }
  if (!record) {
    return { ok: false, error: "unknown agent key", status: 401 };
  }
  if (record.revokedAtMs) {
    return { ok: false, error: "agent key revoked", status: 401 };
  }
  let quota: { ok: boolean; used: number };
  try {
    quota = await checkAgentKeyQuota(store, keyHash);
  } catch {
    return { ok: false, error: "rate limiter unavailable — try again in a moment", status: 503 };
  }
  if (!quota.ok) {
    return {
      ok: false,
      error: `rate limit exceeded: ${AGENT_KEY_RATE_LIMIT} agent executions per hour`,
      status: 429,
    };
  }
  return {
    ok: true,
    identity: {
      userAddress: record.userAddress,
      agentAccountId: record.agentAccountId,
      username: record.username,
      keyId: record.keyId,
    },
  };
}

/** The origin link messages must be addressed to (fail closed in prod). */
export function linkMessageOrigin(): string | null {
  return requireAppOrigin();
}
