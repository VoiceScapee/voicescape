/**
 * vault-keys — turn a mirror-node account key into a Hiero SDK PublicKey.
 *
 * The vault's KeyList needs the HUMAN's public key, and the only honest
 * $0 source is the mirror node: GET /api/v1/accounts/{id} returns the
 * key in protobuf-JSON form:
 *   { "_type": "ECDSA_SECP256K1", "key": "033a11..." }
 * The `key` field is raw compressed public-key bytes as hex.
 *
 * Accounts we MUST reject (spec §1), with plain-words guidance:
 * - hollow accounts (key: null) — no key exists yet
 * - contract accounts — nothing to sign with
 * - opaque ProtobufEncoded keys (system accounts) — can't parse
 * - nested ThresholdKey/KeyList accounts — technically flattenable, but
 *   HashPack's multisig signing UX is unverified, so we refuse rather
 *   than strand the human mid-setup.
 *
 * Mainnet only. Never touches private keys — there is no private-key
 * input anywhere in this module by construction.
 */

import { PublicKey } from "@hiero-ledger/sdk";

export interface MirrorAccountKey {
  _type?: string;
  key?: string | null;
  keys?: Array<{ _type?: string; key?: string | null }>;
  threshold?: number;
}

export type HumanKeyResult =
  | { ok: true; publicKey: PublicKey; keyHex: string; keyType: "ED25519" | "ECDSA_SECP256K1" }
  | { ok: false; error: string; guidance: string };

const HEX_RE = /^[0-9a-fA-F]+$/;

function parseSimpleKey(
  type: string | undefined,
  hex: string | null | undefined,
): PublicKey | null {
  if (!type || !hex || !HEX_RE.test(hex)) return null;
  const t = type.toUpperCase();
  try {
    if (t.includes("ED25519")) {
      // 32-byte raw (64 hex) or DER — fromString auto-detects.
      return hex.length === 64
        ? PublicKey.fromStringED25519(hex.toLowerCase())
        : PublicKey.fromString(hex.toLowerCase());
    }
    if (t.includes("ECDSA") || t.includes("SECP256K1")) {
      return hex.length === 66
        ? PublicKey.fromStringECDSA(hex.toLowerCase())
        : PublicKey.fromString(hex.toLowerCase());
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolve the signable public key for a human account from its mirror-node
 * account body. Returns ok:false with plain-words guidance for every
 * account shape that can't complete the setup signature.
 */
export function humanKeyFromMirrorAccount(
  accountBody: { key?: MirrorAccountKey | null } | null,
): HumanKeyResult {
  const k = accountBody?.key;
  if (!k) {
    return {
      ok: false,
      error: "hollow account",
      guidance:
        "Your account hasn't made its first transaction yet, so it has no key on record. " +
        "Send any tiny transfer from it first, then try the vault setup again.",
    };
  }
  const type = (k._type ?? "").toUpperCase();

  // Opaque system/complex keys (e.g. 0.0.2) — nothing to build a KeyList from.
  if (type.includes("PROTOBUFENCODED")) {
    return {
      ok: false,
      error: "unsupported account key",
      guidance:
        "This account uses a system-level key that can't go in a vault. " +
        "Use a normal wallet account for vault setup.",
    };
  }

  // Nested threshold/multisig accounts: refuse rather than strand the human.
  if (
    type.includes("THRESHOLD") ||
    type.includes("KEYLIST") ||
    Array.isArray(k.keys)
  ) {
    return {
      ok: false,
      error: "multisig account",
      guidance:
        "This account needs multiple signatures, and wallet support for that in vault setup " +
        "isn't verified yet. Please complete vault setup from a single-key account instead.",
    };
  }

  const parsed = parseSimpleKey(k._type, k.key);
  if (!parsed) {
    return {
      ok: false,
      error: "unreadable account key",
      guidance:
        "We couldn't read this account's public key from the network. " +
        "Use a normal wallet account for vault setup.",
    };
  }
  const keyHex = parsed.toStringRaw().toLowerCase();
  const keyType = type.includes("ED25519") ? "ED25519" : "ECDSA_SECP256K1";
  return { ok: true, publicKey: parsed, keyHex, keyType };
}

/**
 * Canonical lowercase raw hex for a mirror key entry, or null when
 * unparseable. Both sides of a key comparison go through this so the
 * match is exact regardless of mirror encoding quirks.
 */
export function canonicalKeyHex(
  type: string | undefined,
  hex: string | null | undefined,
): string | null {
  const p = parseSimpleKey(type, hex);
  return p ? p.toStringRaw().toLowerCase() : null;
}

/**
 * Short fingerprint for display: "a3f9c1d2…e7b4f2a1".
 * Shown on the setup page so the human sees WHICH key they're co-owning with.
 */
export function keyFingerprint(hex: string): string {
  const h = hex.toLowerCase().replace(/^0x/, "");
  if (h.length < 16) return h;
  return `${h.slice(0, 8)}…${h.slice(-8)}`;
}

/**
 * Normalize an agent-submitted public key to 64-char lowercase raw hex.
 * Accepts raw 64-hex (with or without 0x) or DER hex; anything else is
 * rejected. ED25519 only — the vault key is Hedera-native.
 */
export function normalizeAgentPublicKey(
  raw: unknown,
): { ok: true; keyHex: string } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: "agent_public_key must be a hex string" };
  }
  const hex = raw.trim().toLowerCase().replace(/^0x/, "");
  if (!HEX_RE.test(hex) || hex.length === 0) {
    return { ok: false, error: "agent_public_key must be hex (raw 64-char ED25519 or DER)" };
  }
  try {
    const parsed =
      hex.length === 64 ? PublicKey.fromStringED25519(hex) : PublicKey.fromString(hex);
    const rawHex = parsed.toStringRaw().toLowerCase();
    if (rawHex.length !== 64) {
      return { ok: false, error: "agent_public_key must be an ED25519 key (32 bytes)" };
    }
    // The SDK's parser doesn't validate the curve point — an all-zero
    // "key" parses fine but no private key can ever exist for it.
    if (/^0+$/.test(rawHex)) {
      return { ok: false, error: "agent_public_key must be a real ED25519 key (not all zeros)" };
    }
    return { ok: true, keyHex: rawHex };
  } catch {
    return { ok: false, error: "agent_public_key is not a valid ED25519 public key" };
  }
}
