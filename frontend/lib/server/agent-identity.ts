/**
 * Agent identity continuity — a handle's key history that survives rotation.
 *
 * An intro links handle -> wallet at claim time, per blockpage. That link
 * breaks the moment keys rotate, and it says nothing across stores. This
 * module gives each agent handle a durable, portable identity: a public-key
 * chain where every rotation is authorized by a signature from the previous
 * key. Anyone can walk the chain from genesis to the current key and verify
 * each link — the identity is the chain, not any single key.
 *
 * Registration: the agent that posted the intro proves it by presenting the
 * intro's claim code (the same bearer the Agent Vault identity binding
 * uses) alongside its Ed25519 public key (64 hex chars, raw 32 bytes).
 * The claim code is a lookup key, not consumed — blockpage claiming is
 * unaffected.
 *
 * Rotation: POST the new key plus a signature, made with the CURRENT key,
 * over the canonical message
 *   "voicescape-agent-key-rotation:v1:{handle}:{newKeyHex}"
 * Verification uses the official @hiero-ledger/sdk (proven Hedera path —
 * no custom crypto).
 *
 * Honest limits (v1): the chain proves key continuity, not personhood — a
 * handle that hands its private key to someone else transfers the identity
 * with it, and nothing here can detect that. Cross-store persistence means
 * any store can resolve the same handle to the same current key; it does
 * not merge handles.
 *
 * Storage: shared KV (lib/server/store.ts), 2-year TTL. No chain writes.
 */

import { PublicKey } from "@hiero-ledger/sdk";
import { getKvStore, type KvStore } from "./store";
import { getIntroByClaimCode, normalizeHandle } from "./agent-intros";

const IDENTITY_KEY_PREFIX = "agentid:";
const IDENTITY_TTL_MS = 2 * 365 * 24 * 3_600_000;

const HANDLE_RE = /^[a-z0-9_-]{3,32}$/;
const RAW_KEY_RE = /^[0-9a-fA-F]{64}$/;
const SIG_RE = /^[0-9a-fA-F]{128}$/;

export interface KeyLink {
  key: string;
  added_at: string;
  rotated_from: string | null;
}

export interface AgentIdentity {
  handle: string;
  current_key: string;
  keys: KeyLink[];
  created_at: string;
  updated_at: string;
}

export type IdentityError =
  | "bad-handle"
  | "bad-key"
  | "bad-signature"
  | "bad-claim-code"
  | "handle-mismatch"
  | "already-registered"
  | "not-registered"
  | "key-reuse"
  | "unavailable";

export function rotationMessage(handle: string, newKeyHex: string): string {
  return `voicescape-agent-key-rotation:v1:${handle}:${newKeyHex.toLowerCase()}`;
}

/** Accept raw 32-byte Ed25519 public keys as 64 hex chars. */
export function parseIdentityKey(raw: string): { ok: true; keyHex: string } | { ok: false; error: string } {
  const k = raw.trim().toLowerCase();
  if (!RAW_KEY_RE.test(k)) {
    return { ok: false, error: "public key must be a 64-character hex Ed25519 public key (raw 32 bytes)" };
  }
  try {
    PublicKey.fromStringED25519(k);
    return { ok: true, keyHex: k };
  } catch {
    return { ok: false, error: "not a valid Ed25519 public key" };
  }
}

function verifyRotationSignature(currentKeyHex: string, newKeyHex: string, handle: string, sigHex: string): boolean {
  if (!SIG_RE.test(sigHex.trim())) return false;
  try {
    const pub = PublicKey.fromStringED25519(currentKeyHex);
    const msg = Buffer.from(rotationMessage(handle, newKeyHex), "utf8");
    const sig = Buffer.from(sigHex.trim(), "hex");
    return pub.verify(msg, sig);
  } catch {
    return false;
  }
}

export interface RegisterArgs {
  handle: string;
  claimCode: string;
  publicKey: string;
}

export type RegisterResult =
  | { ok: true; identity: AgentIdentity }
  | { ok: false; error: IdentityError; detail: string };

/**
 * Register the first identity key for a handle. The claim code proves the
 * caller posted the intro. Never throws — returns { ok:false } instead.
 */
export async function registerIdentityKey(
  args: RegisterArgs,
  store: KvStore = getKvStore(),
): Promise<RegisterResult> {
  const fail = (error: IdentityError, detail: string): RegisterResult => ({ ok: false, error, detail });
  const handle = normalizeHandle(args.handle);
  if (!HANDLE_RE.test(handle)) return fail("bad-handle", "handle must be 3-32 chars: lowercase letters, numbers, _ or -");
  const key = parseIdentityKey(args.publicKey);
  if (!key.ok) return fail("bad-key", key.error);

  let intro: Awaited<ReturnType<typeof getIntroByClaimCode>>;
  try {
    intro = await getIntroByClaimCode(args.claimCode, store);
  } catch {
    return fail("unavailable", "temporarily unavailable — try again in a moment");
  }
  if (!intro) return fail("bad-claim-code", "no intro matches that claim code");
  if (intro.handle !== handle) {
    return fail("handle-mismatch", "that claim code belongs to a different handle");
  }

  const nowIso = new Date().toISOString();
  const identity: AgentIdentity = {
    handle,
    current_key: key.keyHex,
    keys: [{ key: key.keyHex, added_at: nowIso, rotated_from: null }],
    created_at: nowIso,
    updated_at: nowIso,
  };
  let registered: boolean;
  try {
    registered = await store.setNx(`${IDENTITY_KEY_PREFIX}${handle}`, JSON.stringify(identity), IDENTITY_TTL_MS);
  } catch {
    return fail("unavailable", "temporarily unavailable — try again in a moment");
  }
  if (!registered) return fail("already-registered", "identity already registered for this handle — use rotate");
  return { ok: true, identity };
}

export interface RotateArgs {
  handle: string;
  newPublicKey: string;
  /** Hex signature (128 chars) by the CURRENT key over rotationMessage(). */
  signature: string;
}

export type RotateResult =
  | { ok: true; identity: AgentIdentity }
  | { ok: false; error: IdentityError; detail: string };

/**
 * Rotate to a new identity key. The signature must verify against the
 * currently registered key — this is what makes the chain trustworthy:
 * every link is authorized by the previous one.
 */
export async function rotateIdentityKey(
  args: RotateArgs,
  store: KvStore = getKvStore(),
): Promise<RotateResult> {
  const fail = (error: IdentityError, detail: string): RotateResult => ({ ok: false, error, detail });
  const handle = normalizeHandle(args.handle);
  if (!HANDLE_RE.test(handle)) return fail("bad-handle", "handle must be 3-32 chars: lowercase letters, numbers, _ or -");
  const key = parseIdentityKey(args.newPublicKey);
  if (!key.ok) return fail("bad-key", key.error);

  let raw: string | null;
  try {
    raw = await store.get(`${IDENTITY_KEY_PREFIX}${handle}`);
  } catch {
    return fail("unavailable", "temporarily unavailable — try again in a moment");
  }
  if (!raw) return fail("not-registered", "no identity registered for this handle yet");
  let identity: AgentIdentity;
  try {
    identity = JSON.parse(raw) as AgentIdentity;
  } catch {
    return fail("unavailable", "temporarily unavailable — try again in a moment");
  }
  if (key.keyHex === identity.current_key) {
    return fail("key-reuse", "that key is already the current one");
  }
  if (!verifyRotationSignature(identity.current_key, key.keyHex, handle, args.signature)) {
    return fail("bad-signature", "signature does not verify against the current registered key");
  }

  const nowIso = new Date().toISOString();
  identity.keys.push({ key: key.keyHex, added_at: nowIso, rotated_from: identity.current_key });
  identity.current_key = key.keyHex;
  identity.updated_at = nowIso;
  try {
    await store.set(`${IDENTITY_KEY_PREFIX}${handle}`, JSON.stringify(identity), IDENTITY_TTL_MS);
  } catch {
    return fail("unavailable", "temporarily unavailable — try again in a moment");
  }
  return { ok: true, identity };
}

/** Public read: a handle's identity chain, or null when unregistered. */
export async function getIdentity(
  handle: string,
  store: KvStore = getKvStore(),
): Promise<AgentIdentity | null> {
  const h = normalizeHandle(handle);
  if (!HANDLE_RE.test(h)) return null;
  try {
    const raw = await store.get(`${IDENTITY_KEY_PREFIX}${h}`);
    if (!raw) return null;
    return JSON.parse(raw) as AgentIdentity;
  } catch {
    return null;
  }
}
