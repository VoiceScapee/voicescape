/**
 * claim-reservations — KV-backed SOFT reservations for agent blockpage handles.
 *
 * Converged spec v2 (reviewed by arion, 2026-10-08):
 *   ~/workspace/goals/make-voicescape-go-viral/hidden_files/reservable-claims-scope.md
 *
 * Gated-treasury agents are blocked on synchrony, not cost: the human
 * approval rail takes days, and meanwhile anyone can claim the handle.
 * A reservation turns that async gap from a blocker into a queue.
 *
 * Load-bearing honesty: this is a SOFT HOLD, NOT A LOCK. The Registry
 * contract is unchanged; a direct on-chain registerPage bypassing us still
 * wins. Every public surface says so.
 *
 * Design (all decisions from the converged spec):
 *  - Atomic primitive (H1): single-command `SET key value PX <ttl> NX` on
 *    Upstash/Valkey — exactly one winner, one null loser. The primitive is
 *    named; "atomic" is never a claimed property.
 *  - Claimant nonce: the reservation value carries a claimant-generated
 *    nonce. Lost response after server-side success → GET the key: our
 *    nonce present = we won, absent/foreign = we lost. Fail-closed-throw
 *    becomes a decidable read (one extra GET on the ambiguous path).
 *  - Funding address (H2): pure function of the claimant's secp256k1 key —
 *    its hollow alias (keccak-256 of the uncompressed public key, last 20
 *    bytes). Copy on day 6, fund on day 8 after expiry + re-reservation:
 *    same address, still live.
 *  - Identity (H4): handle → claimant secp256k1 for completion authority;
 *    the intro claim code is a discoverable index, never a credential.
 *    ED25519 keys cannot hollow-create on Hedera — secp256k1 only.
 *  - Caps (Q2): per-claimant-key cap at prepare (handle-lock defense,
 *    atomic via the same SET NX path) + per-funder cap at the completion
 *    transition (farm defense; the funder is unknowable at prepare).
 *  - Declared-then-verified funding (dust-attack fix): the claimant
 *    presents the funding txid at completion; the server verifies it pays
 *    the hollow alias >= the fee floor and reads the payer from chain
 *    data (txid `<payer>@<ts>`, cross-checked against transfers). The
 *    declaration picks WHICH transaction; the chain proves WHO paid.
 *    Dust below the floor is ignored at construction.
 *  - Txid replay guard: txid→reservation_id binding at the completion
 *    transition, first declarer wins (atomic SET NX). Same reservation
 *    re-presenting its txid is allowed (idempotent retry); a different
 *    reservation presenting a used txid is rejected. The declared set
 *    is the complete funding universe.
 *  - Rejection leaves funds claimant-side: no server outbound. The
 *    "refund" is the claimant sweeping their own alias. Omnibus/exchange
 *    funding is priced, not merely imperfect — the cap enforces against
 *    the on-chain payer and the rejection says "funder cap" plainly.
 *  - Explicit release (Q1): claimant-signed release — same-day
 *    availability on operator decline, release+revoke on compromise.
 *  - Tombstones: terminal states are recorded, never deleted.
 *    `released-by-claimant` (an act, with an actor) vs `expired-by-TTL`
 *    (an absence) are distinct row types.
 *  - TTL expiry: automatic, no sweeper, no cooldown. The expired-by-TTL
 *    tombstone is written lazily when the expiry is observed on read.
 *  - Public honesty (H3): surfaces read `reserved (soft, unverified)` +
 *    expiry; reads re-check on-chain availability; a timed-out re-check
 *    surfaces `availability unknown` — never silently open/taken.
 *
 * Never holds keys, never signs, never spends. No chain writes — only
 * read-only mirror-node queries (funding verification).
 */
import { randomBytes, createHash } from "node:crypto";
import { PublicKey } from "@hiero-ledger/sdk";
import { getKvStore, type KvStore } from "./store";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** 7-day soft hold, per the converged spec (7+7 with one renewal). */
export const RESERVATION_TTL_MS = 7 * 24 * 3_600_000;
/** Reservation index outlives the reservation so TTL expiry is observable
 *  on read without a sweeper. 30 days bounds the key leak. */
export const RESERVATION_INDEX_TTL_MS = 30 * 24 * 3_600_000;
/** Per-funder cap: conservative starting policy (spec §6 — Brandon's call
 *  to adjust from observed data). Windowed; see checkFunderCap. */
export const FUNDER_CAP = 3;
export const FUNDER_WINDOW_MS = 30 * 24 * 3_600_000;
/**
 * Fee floor: the minimum viable claim funding. Matches the hollow path's
 * documented minimum ("send at least 1 HBAR"). Dust below this is ignored
 * at completion construction.
 */
export const MIN_FUNDING_TINYBAR = 100_000_000; // 1 HBAR
/** Read-only mirror node base (mirrors mcp-tools' MIRROR_BASE; kept local
 *  to avoid a module cycle — mcp-tools imports this module). */
const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";
const FETCH_TIMEOUT_MS = 15_000;

const RES_KEY_PREFIX = "claim-reservation:";
const BY_KEY_PREFIX = "claim-reservation-by-key:";
const INDEX_KEY_PREFIX = "claim-reservation-index:";
const TOMBSTONE_KEY_PREFIX = "claim-reservation-history:";
const FUNDER_COUNT_PREFIX = "claim-funder-count:";
/**
 * Txid→reservation bindings. Txids are unique forever — 10y is effectively
 * permanent (same as tombstones).
 */
const TXID_USE_PREFIX = "funding-txid-used:";
const TXID_USE_TTL_MS = 10 * 365 * 24 * 3_600_000;

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
/** secp256k1 compressed (02/03 + 32 bytes) or uncompressed (04 + 64 bytes). */
const SECP256K1_RE = /^((02|03)[0-9a-fA-F]{64}|04[0-9a-fA-F]{128})$/;
/** 32-byte keys are ED25519-shaped — they cannot hollow-create on Hedera. */
const ED25519_SHAPE_RE = /^[0-9a-fA-F]{64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CLAIM_CODE_RE = /^[A-Z0-9-]{4,16}$/;
const TXID_RE = /^(0\.0\.\d+)@(\d+)\.(\d{1,9})$/;
const SIG_HEX_RE = /^[0-9a-fA-F]{128}$/; // 64-byte raw ECDSA (r||s)

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface ReservationRecord {
  reservation_id: string;
  nonce: string;
  username: string;
  pubkey_hash: string;
  /** Normalized lowercase hex, no 0x prefix. */
  secp256k1_public_key: string;
  /** 0x EVM address — pure function of the key (hollow alias). */
  funding_address: string;
  intro_claim_code: string | null;
  created_at: number;
  expires_at: number;
  /** 0 or 1 — one renewal max. */
  renewals_used: number;
}

export type TombstoneState =
  | "completed"
  | "released-by-claimant"
  | "expired-by-TTL"
  | "rejected-funder-cap";

export interface ReservationTombstone {
  reservation_id: string;
  username: string;
  terminal_state: TombstoneState;
  pubkey_hash: string;
  /** For released-by-claimant: the key that signed the release. */
  actor_pubkey?: string;
  /** For rejected-funder-cap: the on-chain payer that hit the cap. */
  funder?: string;
  funding_txid?: string;
  reason?: string;
  created_at: number;
  ended_at: number;
}

export type ReserveOutcome =
  | {
      ok: true;
      /** True when the caller's key already held this reservation. */
      existing: boolean;
      /** True when this call consumed the one renewal. */
      renewed: boolean;
      reservation: ReservationRecord;
    }
  | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* Key helpers                                                         */
/* ------------------------------------------------------------------ */

function resKey(username: string): string {
  return `${RES_KEY_PREFIX}${username}`;
}
function byKey(pubkeyHash: string): string {
  return `${BY_KEY_PREFIX}${pubkeyHash}`;
}
function indexKey(username: string): string {
  return `${INDEX_KEY_PREFIX}${username}`;
}
function tombstoneKey(username: string, reservationId: string): string {
  return `${TOMBSTONE_KEY_PREFIX}${username}:${reservationId}`;
}
function funderCountKey(payer: string): string {
  return `${FUNDER_COUNT_PREFIX}${payer}`;
}

/** Normalize + validate a secp256k1 public key. Returns lowercase hex, no 0x. */
export function normalizeSecp256k1Pubkey(raw: string): string {
  const hex = raw.trim().replace(/^0x/, "");
  if (ED25519_SHAPE_RE.test(hex) && !/^(02|03)/.test(hex)) {
    throw new Error(
      "that looks like an ED25519 public key (32 bytes) — hollow accounts need ECDSA (secp256k1). " +
        "Generate a fresh secp256k1 keypair and pass its compressed public key (66 hex chars, 02/03 prefix)",
    );
  }
  if (!SECP256K1_RE.test(hex)) {
    throw new Error(
      "invalid secp256k1 public key — expected compressed hex (66 chars, 02/03 prefix) or uncompressed (130 chars, 04 prefix). Never pass a private key",
    );
  }
  // Validate it parses as a real curve point via the Hiero SDK.
  try {
    PublicKey.fromStringECDSA(hex);
  } catch {
    throw new Error("secp256k1 public key is not a valid curve point");
  }
  return hex.toLowerCase();
}

/** Stable per-key identity for the one-per-key cap. */
export function pubkeyHash(normalizedHex: string): string {
  return createHash("sha256").update(normalizedHex, "utf8").digest("hex");
}

/**
 * Funding address = the claimant key's hollow alias: keccak-256 of the
 * uncompressed public key, last 20 bytes. Pure function of the key —
 * stable across reservation instances. Same derivation as the self-claim
 * hollow path (mcp-tools prepareAgentSelfClaim); never invent another.
 */
export function deriveFundingAddress(normalizedHex: string): string {
  const evm = PublicKey.fromStringECDSA(normalizedHex).toEvmAddress().replace(/^0x/, "");
  return `0x${evm.toLowerCase()}`;
}

/** Canonical message a claimant signs to release a reservation. */
export function releaseMessage(username: string, reservationId: string): string {
  return `voicescape:release-reservation:v1:${username}:${reservationId}`;
}

function parseReservation(raw: string): ReservationRecord | null {
  try {
    const r = JSON.parse(raw) as ReservationRecord;
    if (
      !r ||
      typeof r.reservation_id !== "string" ||
      typeof r.username !== "string" ||
      typeof r.pubkey_hash !== "string" ||
      typeof r.secp256k1_public_key !== "string" ||
      typeof r.funding_address !== "string" ||
      typeof r.expires_at !== "number"
    ) {
      return null;
    }
    return r;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Core: reserve (atomic claim-or-reject)                               */
/* ------------------------------------------------------------------ */

export interface ReserveInput {
  username: string;
  /** secp256k1 public key hex (any accepted form). */
  claimant_pubkey: string;
  /** Claimant-generated nonce (decidable re-read on lost responses). */
  nonce: string;
  /** Intro claim code — discoverable index only, never a credential. */
  claim_code?: string | null;
  /** Consume the one renewal instead of creating. */
  renew?: boolean;
}

/**
 * Atomically reserve a handle for a claimant key — or return the existing
 * reservation / a clean rejection. Exactly one winner per (username);
 * exactly one active reservation per claimant key.
 *
 * `store` is injectable for tests; defaults to the shared store.
 */
export async function reserveHandle(
  input: ReserveInput,
  store: KvStore = getKvStore(),
): Promise<ReserveOutcome> {
  const username = (input.username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return { ok: false, error: `invalid username "${input.username}" — 3-32 chars, a-z 0-9 _ -` };
  }
  let pubkey: string;
  try {
    pubkey = normalizeSecp256k1Pubkey(input.claimant_pubkey ?? "");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "bad claimant_pubkey" };
  }
  const nonce = (input.nonce ?? "").trim();
  if (!NONCE_RE.test(nonce)) {
    return { ok: false, error: "nonce is required (1-128 chars, A-Z a-z 0-9 _ -) — generate it client-side; it makes lost responses decidable" };
  }
  const claimCode = input.claim_code ?? null;
  if (claimCode !== null && !CLAIM_CODE_RE.test(claimCode.trim().toUpperCase())) {
    return { ok: false, error: "bad claim_code — expected the intro claim code from post_agent_intro" };
  }
  const hash = pubkeyHash(pubkey);
  const now = Date.now();

  // Renewal path: extend the caller's own live reservation once.
  if (input.renew) {
    const existing = await readLiveReservation(username, store);
    if (!existing) {
      return { ok: false, error: `no active reservation for "${username}" to renew` };
    }
    if (existing.pubkey_hash !== hash) {
      return { ok: false, error: `reservation for "${username}" belongs to another key — renewals need the bound key` };
    }
    if (existing.renewals_used >= 1) {
      return { ok: false, error: "renewal already used — one renewal per reservation (7+7 max)" };
    }
    const renewed: ReservationRecord = {
      ...existing,
      expires_at: now + RESERVATION_TTL_MS,
      renewals_used: 1,
    };
    // Overwrite (key exists; SET NX would fail) — ownership was verified
    // above. Benign TOCTOU: a concurrent renew just re-extends once more.
    await store.set(resKey(username), JSON.stringify(renewed), RESERVATION_TTL_MS);
    await store.set(byKey(hash), username, RESERVATION_TTL_MS);
    await store.set(
      indexKey(username),
      JSON.stringify({ reservation_id: renewed.reservation_id, pubkey_hash: hash, created_at: renewed.created_at }),
      RESERVATION_INDEX_TTL_MS,
    );
    return { ok: true, existing: true, renewed: true, reservation: renewed };
  }

  const record: ReservationRecord = {
    reservation_id: randomBytes(16).toString("hex"),
    nonce,
    username,
    pubkey_hash: hash,
    secp256k1_public_key: pubkey,
    funding_address: deriveFundingAddress(pubkey),
    intro_claim_code: claimCode ? claimCode.trim().toUpperCase() : null,
    created_at: now,
    expires_at: now + RESERVATION_TTL_MS,
    renewals_used: 0,
  };
  const value = JSON.stringify(record);

  // 1. Claim the handle: single-command SET … NX PX. Exactly one winner.
  const won = await store.setNx(resKey(username), value, RESERVATION_TTL_MS);
  if (!won) {
    const existing = await readLiveReservation(username, store);
    if (existing && existing.pubkey_hash === hash) {
      // Idempotent re-prepare: same key, same handle — return what's held.
      return { ok: true, existing: true, renewed: false, reservation: existing };
    }
    const until = existing ? new Date(existing.expires_at).toISOString() : "unknown";
    return {
      ok: false,
      error:
        `username "${username}" is reserved until ${until} by another agent (soft hold, not a lock — ` +
        `a direct on-chain registerPage still wins; poll lookup_blockpage for release)`,
    };
  }

  // 2. Claim the per-key slot. Roll back the handle on loss — guarded by
  //    reservation_id so we can never delete someone else's newer claim.
  const keyWon = await store.setNx(byKey(hash), username, RESERVATION_TTL_MS);
  if (!keyWon) {
    const holder = await store.get(byKey(hash)).catch(() => null);
    if (holder === username) {
      // Our own stale slot from a partial earlier attempt — proceed.
    } else {
      await deleteReservationKey(username, record.reservation_id, store);
      return {
        ok: false,
        error:
          `one active reservation per claimant key — this key already holds ` +
          (holder ? `"${holder}"` : "another handle"),
      };
    }
  }

  // 3. Index for lazy expiry observation (outlives the reservation key).
  await store.set(
    indexKey(username),
    JSON.stringify({ reservation_id: record.reservation_id, pubkey_hash: hash, created_at: record.created_at }),
    RESERVATION_INDEX_TTL_MS,
  );

  return { ok: true, existing: false, renewed: false, reservation: record };
}

/** Read the live reservation, or null. Never writes tombstones. */
async function readLiveReservation(
  username: string,
  store: KvStore,
): Promise<ReservationRecord | null> {
  const raw = await store.get(resKey(username));
  if (!raw) return null;
  const rec = parseReservation(raw);
  if (!rec || rec.username !== username) return null;
  // Belt-and-suspenders: backends expire via TTL, but if one ever serves
  // a stale value, the in-value expiry wins (arion's KV-lazy point).
  if (rec.expires_at <= Date.now()) return null;
  return rec;
}

/**
 * Public read: the live reservation, or null. When the reservation key is
 * gone but the index says one existed, the TTL expiry is observed here —
 * the expired-by-TTL tombstone is written lazily (no sweeper).
 */
export async function getReservation(
  username: string,
  store: KvStore = getKvStore(),
): Promise<ReservationRecord | null> {
  const name = username.trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return null;
  const raw = await store.get(resKey(name));
  if (raw) {
    const rec = parseReservation(raw);
    if (!rec || rec.username !== name) return null;
    if (rec.expires_at <= Date.now()) {
      await observeExpiry(name, rec, store);
      return null;
    }
    return rec;
  }
  // Key missing — did a reservation expire? The index outlives the key.
  interface ReservationIndex {
    reservation_id: string;
    pubkey_hash: string;
    created_at: number;
  }
  let idx: ReservationIndex | null = null;
  try {
    const idxRaw = await store.get(indexKey(name));
    idx = idxRaw ? (JSON.parse(idxRaw) as ReservationIndex) : null;
  } catch {
    idx = null;
  }
  if (idx && typeof idx.reservation_id === "string") {
    // Don't double-record: completion/release already wrote a tombstone
    // and should have cleared the index; a crash between the two is the
    // only way both exist.
    const already = await getTombstone(name, idx.reservation_id, store).catch(() => null);
    if (!already) {
      await writeTombstone(
        {
          reservation_id: idx.reservation_id,
          username: name,
          terminal_state: "expired-by-TTL",
          pubkey_hash: idx.pubkey_hash ?? "unknown",
          created_at: idx.created_at ?? 0,
          ended_at: Date.now(),
          reason: "7-day TTL elapsed with no completion or release",
        },
        store,
      ).catch(() => {});
    }
    await store.del(indexKey(name)).catch(() => {});
  }
  return null;
}

/** No-op for prompt backends; kept explicit for the lazy-backend case. */
async function observeExpiry(
  username: string,
  rec: ReservationRecord,
  store: KvStore,
): Promise<void> {
  const already = await getTombstone(username, rec.reservation_id, store).catch(() => null);
  if (!already) {
    await writeTombstone(
      {
        reservation_id: rec.reservation_id,
        username,
        terminal_state: "expired-by-TTL",
        pubkey_hash: rec.pubkey_hash,
        created_at: rec.created_at,
        ended_at: Date.now(),
        reason: "in-value expiry observed on read (backend served a stale value)",
      },
      store,
    ).catch(() => {});
  }
  await store.del(resKey(username)).catch(() => {});
  await store.del(indexKey(username)).catch(() => {});
}

/** Delete the reservation key only if it still holds our reservation_id. */
async function deleteReservationKey(
  username: string,
  reservationId: string,
  store: KvStore,
): Promise<void> {
  const raw = await store.get(resKey(username)).catch(() => null);
  const rec = raw ? parseReservation(raw) : null;
  if (rec && rec.reservation_id === reservationId) {
    await store.del(resKey(username));
  }
}

/**
 * Delete a whole reservation (key + per-key slot + index), guarded so a
 * newer reservation for the same username is never touched.
 */
export async function deleteReservation(
  username: string,
  reservationId: string,
  store: KvStore = getKvStore(),
): Promise<void> {
  const raw = await store.get(resKey(username)).catch(() => null);
  const rec = raw ? parseReservation(raw) : null;
  if (rec && rec.reservation_id === reservationId) {
    await store.del(resKey(username));
    const slot = await store.get(byKey(rec.pubkey_hash)).catch(() => null);
    if (slot === username) await store.del(byKey(rec.pubkey_hash));
    await store.del(indexKey(username)).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Release: claimant-signed explicit release                            */
/* ------------------------------------------------------------------ */

/**
 * Release a reservation early — same-day availability on operator decline,
 * release+revoke on compromise. The signature must be a 64-byte raw ECDSA
 * (r||s) hex signature over the UTF-8 bytes of
 * `voicescape:release-reservation:v1:<username>:<reservation_id>`,
 * made by the bound secp256k1 key. Writes a released-by-claimant
 * tombstone (an act, with an actor).
 */
export async function releaseReservation(
  username: string,
  signatureHex: string,
  store: KvStore = getKvStore(),
): Promise<{ released: true; username: string } | { error: string }> {
  const name = username.trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return { error: "invalid username" };
  const sig = (signatureHex ?? "").trim().replace(/^0x/, "");
  if (!SIG_HEX_RE.test(sig)) {
    return { error: "invalid signature — expected 128 hex chars (64-byte raw ECDSA r||s)" };
  }
  const rec = await getReservation(name, store).catch(() => null);
  if (!rec) return { error: `no active reservation for "${name}"` };
  let ok = false;
  try {
    const pub = PublicKey.fromStringECDSA(rec.secp256k1_public_key);
    ok = pub.verify(Buffer.from(releaseMessage(name, rec.reservation_id), "utf8"), Buffer.from(sig, "hex"));
  } catch {
    ok = false;
  }
  if (!ok) {
    return {
      error:
        "invalid release signature — sign the canonical release message " +
        `"${releaseMessage(name, rec.reservation_id)}" with the bound secp256k1 key`,
    };
  }
  await deleteReservation(name, rec.reservation_id, store);
  await writeTombstone(
    {
      reservation_id: rec.reservation_id,
      username: name,
      terminal_state: "released-by-claimant",
      pubkey_hash: rec.pubkey_hash,
      actor_pubkey: rec.secp256k1_public_key,
      created_at: rec.created_at,
      ended_at: Date.now(),
      reason: "claimant-signed release",
    },
    store,
  );
  return { released: true, username: name };
}

/* ------------------------------------------------------------------ */
/* Tombstones                                                          */
/* ------------------------------------------------------------------ */

/** Terminal states are recorded, never deleted. No TTL. */
export async function writeTombstone(
  t: ReservationTombstone,
  store: KvStore = getKvStore(),
): Promise<void> {
  // Effectively permanent: 10-year TTL (the store requires a TTL).
  await store.set(tombstoneKey(t.username, t.reservation_id), JSON.stringify(t), 10 * 365 * 24 * 3_600_000);
}

export async function getTombstone(
  username: string,
  reservationId: string,
  store: KvStore = getKvStore(),
): Promise<ReservationTombstone | null> {
  const raw = await store.get(tombstoneKey(username, reservationId));
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as ReservationTombstone;
    if (!t || t.reservation_id !== reservationId) return null;
    return t;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Funding verification (declared-then-verified)                        */
/* ------------------------------------------------------------------ */

export interface FundingVerification {
  /** On-chain payer of the presented funding transaction. */
  payer: string;
  /** Total tinybar credited to the hollow alias in that transaction. */
  fundedTinybar: number;
  /** The alias's 0.0.x account id (auto-created on first funding). */
  aliasAccountId: string;
}

type FetchFn = typeof fetch;

async function fetchJson(
  fetchFn: FetchFn,
  url: string,
): Promise<{ ok: boolean; status: number; body: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { headers: { Accept: "application/json" }, signal: ctrl.signal });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Declared-then-verified funding: the claimant presents the funding txid
 * (they know it — their operator sent it). The server verifies that
 * transaction pays the hollow alias >= the fee floor and reads the payer
 * from chain data. The declaration picks WHICH transaction; the chain
 * proves WHO paid. Never a declared field.
 *
 * Dust-attack note: anyone can dust a public funding address, but dust
 * that wasn't declared is simply not this completion's funding — the
 * attacker can never become funder-of-record.
 */
export async function verifyFundingTxid(
  fundingTxid: string,
  fundingAddress: string,
  fetchFn: FetchFn = fetch,
): Promise<FundingVerification | { error: string }> {
  const txid = (fundingTxid ?? "").trim();
  const m = TXID_RE.exec(txid);
  if (!m) {
    return { error: "invalid funding_txid — expected a Hedera transaction id like 0.0.1234@1234567890.123456789" };
  }
  const declaredPayer = m[1];

  // Resolve the hollow alias to its 0.0.x account (auto-created on funding).
  const aliasRes = await fetchJson(fetchFn, `${MIRROR_BASE}/accounts/${fundingAddress}`);
  if (aliasRes.status === 404 || !aliasRes.ok || !aliasRes.body?.account) {
    return { error: "no funding found — the hollow alias has no account yet; fund it first, then complete" };
  }
  const aliasAccountId = String(aliasRes.body.account);

  const txRes = await fetchJson(fetchFn, `${MIRROR_BASE}/transactions/${encodeURIComponent(txid)}`);
  if (txRes.status === 404) {
    return { error: "funding transaction not found on Hedera mainnet — check the txid" };
  }
  if (!txRes.ok || !txRes.body) {
    return { error: "mirror node unreachable — try again in a moment" };
  }
  // Cross-check: the echoed transaction_id's payer must match the declared one.
  const echoed = String(txRes.body.transaction_id ?? "");
  const em = TXID_RE.exec(echoed);
  if (!em || em[1] !== declaredPayer) {
    return { error: "funding_txid mismatch — the transaction record does not match the presented id" };
  }
  const transfers: Array<{ account?: string; amount?: number }> = Array.isArray(txRes.body.transfers)
    ? txRes.body.transfers
    : [];
  let fundedTinybar = 0;
  for (const t of transfers) {
    if (t && t.account === aliasAccountId && typeof t.amount === "number" && t.amount > 0) {
      fundedTinybar += t.amount;
    }
  }
  if (fundedTinybar < MIN_FUNDING_TINYBAR) {
    return {
      error:
        `funding transaction pays ${(fundedTinybar / 100_000_000).toFixed(4)} HBAR to the alias — ` +
        `below the ${(MIN_FUNDING_TINYBAR / 100_000_000).toFixed(2)} HBAR minimum. Dust below the floor is ignored; present the real funding txid`,
    };
  }
  return { payer: declaredPayer, fundedTinybar, aliasAccountId };
}

/* ------------------------------------------------------------------ */
/* Funder cap (farm defense, enforced at the completion transition)      */
/* ------------------------------------------------------------------ */

/**
 * Per-funder cap, checked inside the completion transition.
 * Incr-then-check: the increment is atomic, so each caller gets a unique
 * sequence number — exactly FUNDER_CAP callers see n <= cap. Over-cap
 * callers are rejected; their increment stands (fail-closed: the window
 * only gets stricter, never looser). Windowed by FUNDER_WINDOW_MS.
 *
 * Honest caveat (spec §3): the cap enforces against the ON-CHAIN payer.
 * Exchange/omnibus withdrawals attribute to the exchange account — priced,
 * not merely imperfect. The rejection says "funder cap" plainly so the
 * human knows the fix is funding from a wallet they control.
 */
export async function checkFunderCap(
  payer: string,
  store: KvStore = getKvStore(),
): Promise<{ ok: true; used: number } | { error: string }> {
  if (!/^0\.0\.\d+$/.test(payer)) return { error: "bad payer account id" };
  const n = await store.incr(funderCountKey(payer), FUNDER_WINDOW_MS);
  if (n > FUNDER_CAP) {
    return {
      error:
        `funder cap: ${payer} has reached ${FUNDER_CAP} funded claims per 30 days — ` +
        `fund from a wallet you control, not retrying`,
    };
  }
  return { ok: true, used: n };
}

/* ------------------------------------------------------------------ */
/* Txid replay guard (first declarer wins)                             */
/* ------------------------------------------------------------------ */

/**
 * Txid→reservation binding at the completion transition (arion's replay
 * guard): the same funding txid must never back two completions. First
 * declarer wins via atomic SET NX; the same reservation re-presenting
 * its own txid is allowed (idempotent retry on transient failure); a
 * different reservation presenting a used txid is rejected. The declared
 * set becomes the complete funding universe — closed world.
 *
 * The binding is written after verifyFundingTxid passes, before the
 * funder-cap check — so even a cap-rejected completion consumes its
 * txid (the funds were attributed; the txid can't back another claim).
 */
export async function claimFundingTxid(
  fundingTxid: string,
  reservationId: string,
  store: KvStore = getKvStore(),
): Promise<{ ok: true } | { error: string }> {
  const txid = (fundingTxid ?? "").trim();
  if (!TXID_RE.test(txid)) {
    return { error: "invalid funding_txid — expected a Hedera transaction id like 0.0.1234@1234567890.123456789" };
  }
  const key = `${TXID_USE_PREFIX}${txid}`;
  const replayError =
    "funding transaction already used for another claim — each funding txid backs exactly one completion. " +
    "Fund the alias with a fresh transaction and present its txid";
  const existing = await store.get(key).catch(() => null);
  if (existing != null) {
    return existing === reservationId ? { ok: true } : { error: replayError };
  }
  const won = await store.setNx(key, reservationId, TXID_USE_TTL_MS);
  if (won) return { ok: true };
  // Lost the race between the read and the SET NX — re-read to decide.
  const winner = await store.get(key).catch(() => null);
  return winner === reservationId ? { ok: true } : { error: replayError };
}
