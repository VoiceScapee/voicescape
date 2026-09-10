/**
 * Voicescape "Sign in with wallet" — message construction, parsing and
 * validation (EIP-4361-style).
 *
 * This module is shared by the browser (build + client-side verify) and the
 * server (authoritative verify). It is PURE: no browser or Node-only APIs
 * except `ethers` (signature recovery) and WebCrypto-standard TextEncoder /
 * getRandomValues, which exist in both modern browsers and Node 18+.
 *
 * Message format:
 *
 *   Voicescape wants you to sign in with your wallet:
 *
 *   <address>
 *
 *   App: Voicescape
 *   URI: <origin>               (EIP-4361 "uri": binds the signature to this
 *                              deployment, e.g. https://voicescape.app —
 *                              a signature minted for another site is rejected)
 *   Address: <address>          (0x… for EVM, 0.0.x for Hedera)
 *   Chain ID: <number>
 *   Nonce: <32 hex chars>
 *   Issued At: <ISO-8601>
 *   Expires At: <ISO-8601>
 */

import { ethers } from "ethers";

export const APP_NAME = "Voicescape";
/** Sessions live 7 days, then the user signs again. */
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
/** Clock skew tolerated between client and server. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Header carrying the session credential on API requests. */
export const SESSION_HEADER = "x-vs-session";

export interface SignInFields {
  /** As written in the message: 0x… (EVM) or 0.0.x (Hedera). */
  address: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  /** Origin the sign-in is addressed to, e.g. "https://voicescape.app". */
  uri: string;
}

export interface SessionCredential {
  message: string;
  signature: string;
}

/** Thrown (client) / returned as 401 (server) when sign-in is required. */
export class SignInRequired extends Error {
  constructor(message = "Sign in with your wallet to continue.") {
    super(message);
    this.name = "SignInRequired";
  }
}

export function buildSignInMessage(f: SignInFields): string {
  return [
    `${APP_NAME} wants you to sign in with your wallet:`,
    ``,
    f.address,
    ``,
    `App: ${APP_NAME}`,
    `URI: ${f.uri}`,
    `Address: ${f.address}`,
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expires At: ${f.expiresAt}`,
  ].join("\n");
}

/** 16 random bytes as 32 lowercase hex chars. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("Invalid hex string.");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Strict-parse a sign-in message. Returns null when the shape is wrong.
 * Semantic checks (app name, chain id, timestamps) are done by
 * validateSignInMessage so tests can exercise them separately.
 */
export function parseSignInMessage(text: string): SignInFields | null {
  if (typeof text !== "string") return null;
  const lines = text.split("\n");
  if (lines.length < 11) return null;
  if (lines[0] !== `${APP_NAME} wants you to sign in with your wallet:`) return null;
  if (lines[1] !== "" || lines[3] !== "") return null;
  const address = lines[2].trim();
  if (!address) return null;
  const kv: Record<string, string> = {};
  for (let i = 4; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx < 0) return null;
    kv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const chainId = Number(kv["Chain ID"]);
  if (!kv["App"] || !kv["URI"] || !kv["Address"] || !kv["Nonce"] || !kv["Issued At"] || !kv["Expires At"]) return null;
  if (!Number.isInteger(chainId) || chainId <= 0) return null;
  if (kv["Address"] !== address) return null;
  return {
    address,
    chainId,
    nonce: kv["Nonce"],
    issuedAt: kv["Issued At"],
    expiresAt: kv["Expires At"],
    uri: kv["URI"],
  };
}

export interface MessageValidation {
  ok: boolean;
  reason?: string;
  fields?: SignInFields;
}

/**
 * Canonicalize an origin for comparison: trim, lowercase, strip trailing
 * slashes. "https://Foo.com/" and "https://foo.com" are the same origin.
 */
export function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * Semantic validation of a parsed message against the server's expectations.
 * Pure and fully unit-testable.
 */
export function validateSignInMessage(
  text: string,
  opts: { expectedChainId: number; nowMs?: number; expectedOrigin?: string | null },
): MessageValidation {
  const fields = parseSignInMessage(text);
  if (!fields) return { ok: false, reason: "unrecognized sign-in message format" };
  const now = opts.nowMs ?? Date.now();

  // Exact check on the raw App line (parse() only checked presence).
  const appLine = text.split("\n").find((l) => l.startsWith("App:"));
  if (appLine !== `App: ${APP_NAME}`) return { ok: false, reason: "message is not for Voicescape" };

  // Origin binding (EIP-4361 "uri"): a signature minted for another site
  // must not authenticate here. Skipped only when the server has no
  // origin configured (local dev); production must set APP_ORIGIN.
  if (!fields.uri || /\s/.test(fields.uri)) return { ok: false, reason: "sign-in has no valid origin" };
  if (opts.expectedOrigin != null && normalizeOrigin(fields.uri) !== normalizeOrigin(opts.expectedOrigin)) {
    return { ok: false, reason: "sign-in is for a different site" };
  }

  const isHederaAddr = /^0\.0\.\d+$/.test(fields.address);
  const isEvmAddr = /^0x[0-9a-fA-F]{40}$/.test(fields.address);
  if (!isHederaAddr && !isEvmAddr) return { ok: false, reason: "address is not a 0x or 0.0.x address" };

  if (fields.chainId !== opts.expectedChainId) {
    return { ok: false, reason: `wrong chain (message chain ${fields.chainId})` };
  }
  if (!/^[0-9a-f]{32}$/.test(fields.nonce)) return { ok: false, reason: "malformed nonce" };

  const issued = Date.parse(fields.issuedAt);
  const expires = Date.parse(fields.expiresAt);
  if (Number.isNaN(issued) || Number.isNaN(expires)) return { ok: false, reason: "bad timestamps" };
  if (issued > now + CLOCK_SKEW_MS) return { ok: false, reason: "message issued in the future" };
  if (expires <= now) return { ok: false, reason: "sign-in expired" };
  if (expires <= issued) return { ok: false, reason: "expiry is not after issuance" };
  if (expires - issued > SESSION_TTL_MS + CLOCK_SKEW_MS) {
    return { ok: false, reason: "session lifetime too long" };
  }
  return { ok: true, fields };
}

/**
 * Canonical 0x address for ownership comparisons.
 * Hedera "0.0.123" → long-zero EVM form; EVM 0x… → lowercase.
 */
export function canonicalAddress(address: string): string | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return address.toLowerCase();
  const m = /^0\.0\.(\d+)$/.exec(address);
  if (m) {
    try {
      return ("0x" + BigInt(m[1]).toString(16).padStart(40, "0")).toLowerCase();
    } catch {
      return null;
    }
  }
  return null;
}

/** True for Hedera-style account ids (0.0.x). */
export function isHederaAccountId(address: string): boolean {
  return /^0\.0\.\d+$/.test(address);
}

/** Client-side EVM signature check: recovered address must match. */
export function verifyEvmSignature(message: string, signature: string, expectedAddress: string): boolean {
  try {
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Header transport                                                    */
/* ------------------------------------------------------------------ */

function utf8ToB64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa exists in browsers and Node 16+.
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToUtf8(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Encode a credential for the x-vs-session header. */
export function encodeCredential(cred: SessionCredential): string {
  return utf8ToB64Url(JSON.stringify({ message: cred.message, signature: cred.signature }));
}

/** Decode the x-vs-session header value. Null when malformed. */
export function decodeCredential(value: string | null | undefined): SessionCredential | null {
  if (!value || typeof value !== "string") return null;
  try {
    const obj = JSON.parse(b64UrlToUtf8(value)) as { message?: unknown; signature?: unknown };
    if (typeof obj.message !== "string" || typeof obj.signature !== "string") return null;
    if (!/^0x[0-9a-fA-F]+$/.test(obj.signature.trim())) return null;
    return { message: obj.message, signature: obj.signature.trim() };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Session lifecycle helpers (pure — the React provider wraps these)   */
/* ------------------------------------------------------------------ */

export interface StoredSession {
  /** Stateless HMAC session token issued by /api/auth/login. */
  token: string;
  address: string; // canonical 0x, lowercase
  chainId: number;
  adapterId: string;
  expiresAtMs: number;
}

/**
 * Build the stored-session record from a freshly issued login token.
 * The message/signature were consumed by the server at login time; the
 * client keeps only the token.
 */
export function createSession(args: {
  token: string;
  address: string; // canonical 0x lowercase
  chainId: number;
  adapterId: string;
  expiresAtMs: number;
}): StoredSession {
  if (!args.token || typeof args.token !== "string") {
    throw new Error("Cannot create a session without a token.");
  }
  if (!Number.isSafeInteger(args.expiresAtMs) || args.expiresAtMs <= Date.now()) {
    throw new Error("Session token has no valid expiry.");
  }
  return {
    token: args.token,
    address: args.address.toLowerCase(),
    chainId: args.chainId,
    adapterId: args.adapterId,
    expiresAtMs: args.expiresAtMs,
  };
}

export function serializeSession(s: StoredSession): string {
  return JSON.stringify(s);
}

export interface RestoreResult {
  session: StoredSession | null;
  reason?: string;
}

/**
 * Restore a persisted session. Returns null (with reason) when expired or
 * malformed. The token is server-signed (HMAC) — the server verifies it
 * authoritatively on every request, so the client only needs the shape +
 * expiry sanity check here.
 */
export function restoreSession(raw: string | null | undefined, nowMs = Date.now()): RestoreResult {
  if (!raw) return { session: null, reason: "empty" };
  let s: StoredSession;
  try {
    s = JSON.parse(raw) as StoredSession;
  } catch {
    return { session: null, reason: "corrupt" };
  }
  if (!s || typeof s.token !== "string" || !s.token) {
    return { session: null, reason: "corrupt" };
  }
  if (!s.expiresAtMs || s.expiresAtMs <= nowMs) return { session: null, reason: "expired" };
  return { session: s };
}
