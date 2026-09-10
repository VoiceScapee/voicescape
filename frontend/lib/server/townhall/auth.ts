/**
 * Voicescape Social Town Hall — wallet-signature session verification.
 *
 * Sign-in flow:
 *  1. The client signs an EIP-4361-style "Sign in with Voicescape" message
 *     (see ../../../session-message.ts) and POSTs { message, signature }
 *     ONCE to /api/auth/login.
 *  2. The server verifies the wallet signature (EVM: ecrecover; Hedera:
 *     Ed25519 against the mirror-node account key), binds the nonce, and
 *     issues a STATELESS session token: an HMAC-signed (SESSION_SECRET)
 *     payload carrying address/chainId/nonce/expiry. No server storage.
 *  3. The client sends the token in the `x-vs-session` header on every
 *     write. Verification is pure HMAC + expiry — no mirror-node lookup,
 *     no per-request crypto beyond HMAC, works across N instances.
 *
 * Verification:
 *  - token path (string credential): HMAC verified with SESSION_SECRET,
 *    expiry enforced from the token itself, 7-day lifetime.
 *  - legacy path ({ message, signature } object, used by /api/auth/login):
 *    message parses and passes semantic validation (app, chain id, nonce,
 *    issued-at/expiry, ORIGIN binding) — see session-message.ts
 *  - EVM sessions (0x address): ethers.verifyMessage must recover the
 *    claimed address
 *  - Hedera sessions (0.0.x address): the account's public key is fetched
 *    from the mirror node and the Ed25519 signature is verified with Node's
 *    crypto. Only ED25519 keys are supported — anything else is rejected,
 *    never faked.
 *
 * BEARER-TOKEN CAVEAT (do not soften this): the session token IS the
 * credential for the 7-day session lifetime. Anyone holding it can write
 * as that wallet until expiry; there is no server-side revocation list
 * (that is the price of statelessness). The nonce claim below only
 * rejects a *different* signature presented on a reused nonce — it does
 * NOT prevent replay of the token itself. This is accepted for v1; the
 * real backstop is that high-value actions (e.g. a marketplace purchase)
 * are signed by the wallet on-chain, not by the session.
 *  - nonces are claimed in the shared store with the session's expiry as
 *    TTL: the same nonce presented with a different signature is rejected
 *    on every instance.
 *
 * PRODUCTION CONFIG (fail closed): SESSION_SECRET and APP_ORIGIN are
 * required when NODE_ENV=production. Any auth attempt without them throws
 * instead of silently weakening security. Dev falls back with loud
 * warnings.
 *
 * The key fetcher is injectable so tests never touch the network.
 */

import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "crypto";
import { ethers } from "ethers";
import { getActiveChain } from "../../chains";
import { getKvStore } from "../store";
import { mirrorBaseUrl } from "./topics";
import {
  canonicalAddress,
  hexToBytes,
  isHederaAccountId,
  validateSignInMessage,
  CLOCK_SKEW_MS,
  SESSION_TTL_MS,
  type SessionCredential,
} from "../../session-message";

export type { SessionCredential };

export interface VerifiedSession {
  /** Canonical 0x address (lowercase) for registry-owner comparisons. */
  address: string;
  chainId: number;
  nonce: string;
  expiresAtMs: number;
}

export type VerifyResult =
  | { ok: true; session: VerifiedSession }
  | { ok: false; error: string };

export interface AccountKey {
  keyHex: string; // raw hex, no 0x
  keyType: string; // e.g. "ED25519"
}

export interface AuthPort {
  verifySession(cred: unknown): Promise<VerifyResult>;
}

export interface AuthPortOpts {
  /** Override the expected chain id (tests). Defaults to the active chain. */
  chainId?: () => number;
  /** Override the mirror-node account key lookup (tests). */
  fetchAccountKey?: (accountId: string) => Promise<AccountKey | null>;
  /** Override "now" (tests). */
  nowMs?: () => number;
  /**
   * Override the origin sign-in messages must be addressed to (tests).
   * Defaults to APP_ORIGIN / NEXT_PUBLIC_APP_URL. Null skips the origin
   * check (local dev only — production must set APP_ORIGIN, otherwise a
   * signature minted for a phishing site would verify here).
   */
  origin?: () => string | null;
}

/**
 * The canonical origin sign-in messages must be addressed to (EIP-4361
 * "uri" binding). In production this is REQUIRED — fail closed instead of
 * silently accepting signatures minted for any site.
 */
export function appOriginFromEnv(): string | null {
  const raw = (process.env.APP_ORIGIN ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  return raw ? raw : null;
}

let originWarned = false;

/**
 * Resolve the required sign-in origin. Throws in production when
 * unconfigured (fail closed); warns once in dev and returns null (check
 * skipped, local dev only).
 */
export function requireAppOrigin(): string | null {
  const origin = appOriginFromEnv();
  if (origin) return origin;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[auth] APP_ORIGIN is required in production — refusing to verify sign-ins " +
        "without origin binding (a signature minted for a phishing site would verify). " +
        "Set APP_ORIGIN (or NEXT_PUBLIC_APP_URL) to the deployment's public origin, e.g. https://voicescape.app",
    );
  }
  if (!originWarned) {
    originWarned = true;
    console.warn(
      "[auth] WARNING: APP_ORIGIN is not set — sign-in origin binding is SKIPPED. " +
        "This is only acceptable in local dev. Production refuses to boot auth without it.",
    );
  }
  return null;
}

let secretWarned = false;

/**
 * The HMAC secret that signs stateless session tokens. Required in
 * production (fail closed); dev falls back to a hardcoded value with a
 * loud warning (tokens then don't survive a secret change — fine for
 * dev, fatal for prod, hence the throw above).
 *
 * Generate with: openssl rand -hex 32
 */
export function getSessionSecret(): string {
  const secret = (process.env.SESSION_SECRET ?? "").trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[auth] SESSION_SECRET is required in production — refusing to issue or verify " +
        "session tokens without it. Generate one with `openssl rand -hex 32` and set SESSION_SECRET.",
    );
  }
  if (!secretWarned) {
    secretWarned = true;
    console.warn(
      "[auth] WARNING: SESSION_SECRET is not set — using an insecure dev default. " +
        "Session tokens are forgeable by anyone who reads this source. " +
        "Set SESSION_SECRET in production (the server refuses to run auth without it).",
    );
  }
  return "dev-only-session-secret-NEVER-use-in-production";
}

/* ------------------------------------------------------------------ */
/* Stateless session tokens (HMAC, no server storage)                  */
/* ------------------------------------------------------------------ */

export interface SessionTokenClaims {
  /** Token format version. */
  v: 1;
  /** Canonical address (0x lowercase). */
  addr: string;
  chainId: number;
  nonce: string;
  /** Issued-at, ms epoch. */
  iat: number;
  /** Expiry, ms epoch (7 days after issuance). */
  exp: number;
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

/**
 * Issue a stateless session token for a verified wallet session.
 * Everything verification needs is inside the token, signed with
 * SESSION_SECRET — no server-side session storage.
 */
export function issueSessionToken(
  session: { address: string; chainId: number; nonce: string; expiresAtMs: number },
  nowMs: number = Date.now(),
): string {
  const claims: SessionTokenClaims = {
    v: 1,
    addr: session.address.toLowerCase(),
    chainId: session.chainId,
    nonce: session.nonce,
    iat: nowMs,
    exp: session.expiresAtMs,
  };
  const body = b64urlEncode(JSON.stringify(claims));
  const sig = createHmac("sha256", getSessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Verify a stateless session token. Pure HMAC + structural/expiry checks —
 * no I/O, safe to call on every request on every instance.
 */
export function verifySessionToken(token: string, nowMs: number = Date.now()): VerifyResult {
  if (typeof token !== "string" || !token) return { ok: false, error: "missing session: sign in with your wallet" };
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, error: "malformed session token" };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected: string;
  try {
    expected = createHmac("sha256", getSessionSecret()).update(body).digest("base64url");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "session configuration error" };
  }
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: "invalid session token" };
  }
  let claims: SessionTokenClaims;
  try {
    claims = JSON.parse(b64urlDecode(body)) as SessionTokenClaims;
  } catch {
    return { ok: false, error: "malformed session token" };
  }
  if (!claims || claims.v !== 1 || typeof claims.addr !== "string" || !/^0x[0-9a-f]{40}$/.test(claims.addr)) {
    return { ok: false, error: "malformed session token" };
  }
  if (!Number.isInteger(claims.chainId) || claims.chainId <= 0) {
    return { ok: false, error: "malformed session token" };
  }
  if (typeof claims.nonce !== "string" || !/^[0-9a-f]{32}$/.test(claims.nonce)) {
    return { ok: false, error: "malformed session token" };
  }
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= nowMs) {
    return { ok: false, error: "session expired — sign in again" };
  }
  if (!Number.isSafeInteger(claims.iat) || claims.iat > nowMs + 5 * 60 * 1000) {
    return { ok: false, error: "malformed session token" };
  }
  // Defense in depth: the wallet-message validation already caps lifetime
  // at issuance, but the token must be independently bounded — a token
  // whose lifetime exceeds 7 days is rejected no matter who signed it.
  if (claims.exp - claims.iat > SESSION_TTL_MS + CLOCK_SKEW_MS) {
    return { ok: false, error: "malformed session token" };
  }
  return {
    ok: true,
    session: {
      address: claims.addr,
      chainId: claims.chainId,
      nonce: claims.nonce,
      expiresAtMs: claims.exp,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Nonce claims (single-use-ish, shared store)                         */
/* ------------------------------------------------------------------ */

/**
 * Claim a sign-in nonce: the first presentation wins; the identical
 * (address, signature) presented again is fine (login retries / the same
 * wallet signing in twice); a DIFFERENT signature on the same nonce is
 * rejected — that is the phishing-replay signal. Claims live in the
 * shared store with the session's expiry as TTL, so every instance
 * enforces the binding.
 */
async function checkNonceClaim(
  address: string,
  nonce: string,
  signature: string,
  expiresAtMs: number,
  nowMs: number,
): Promise<string | null> {
  const ttlMs = expiresAtMs - nowMs;
  if (ttlMs <= 0) return "sign-in expired";
  const key = `vs:nonce:${nonce}`;
  const value = `${address}:${sigFingerprint(signature)}`;
  const store = getKvStore();
  let claimed: boolean;
  try {
    claimed = await store.setNx(key, value, ttlMs);
  } catch (e) {
    throw new Error(
      `sign-in nonce store unreachable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (claimed) return null;
  const existing = await store.get(key).catch(() => null);
  if (existing === value) return null; // identical session re-presented
  return "sign-in nonce reuse detected";
}

function sigFingerprint(signature: string): string {
  return createHash("sha256").update(signature.toLowerCase()).digest("hex");
}

/** Test helper: clear nonce claims (shared-store prefix). */
export async function clearNonceRegistry(): Promise<void> {
  await getKvStore().clearPrefix("vs:nonce:");
}

/* ------------------------------------------------------------------ */
/* Hedera: mirror-node public key + Ed25519 verification                */
/* ------------------------------------------------------------------ */

interface MirrorAccountResponse {
  key?: { _type?: string; key?: string };
}

async function defaultFetchAccountKey(accountId: string): Promise<AccountKey | null> {
  const url = `${mirrorBaseUrl()}/api/v1/accounts/${encodeURIComponent(accountId)}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json: MirrorAccountResponse;
  try {
    json = (await res.json()) as MirrorAccountResponse;
  } catch {
    return null;
  }
  const keyHex = json.key?.key;
  if (!keyHex || !/^[0-9a-fA-F]+$/.test(keyHex)) return null;
  return { keyHex, keyType: json.key?._type ?? "UNKNOWN" };
}

/**
 * Hedera message-signing convention (from @hashgraph/hedera-wallet-connect):
 * wallets sign `"\x19Hedera Signed Message:\n" + message.length + message`
 * (length = JS string length), UTF-8 encoded — the Hedera analogue of
 * Ethereum's personal_sign prefix. We replicate it exactly here.
 *
 * We accept signatures over the prefixed bytes OR the raw message bytes:
 * both are deterministic functions of the exact sign-in text, so either
 * requires the wallet's private key. This covers both the standard
 * prefixed flow and wallets that sign raw bytes.
 */
export function hederaSignedMessageBytes(message: string): Uint8Array {
  const prefixed = "Hedera Signed Message:\n" + message.length + message;
  return new TextEncoder().encode(prefixed);
}

function verifyHederaSignature(message: string, sigBytes: Uint8Array, keyBytes: Uint8Array): boolean {
  const msgBytes = new TextEncoder().encode(message);
  return (
    verifyEd25519(hederaSignedMessageBytes(message), sigBytes, keyBytes) ||
    verifyEd25519(msgBytes, sigBytes, keyBytes)
  );
}
/**
 * Verify a raw Ed25519 signature. The mirror node returns the 32-byte
 * public key as hex; Node's crypto needs it as SPKI DER.
 */
export function verifyEd25519(message: Uint8Array, signature: Uint8Array, rawKey: Uint8Array): boolean {
  if (rawKey.length !== 32 || signature.length !== 64) return false;
  try {
    // SPKI DER for Ed25519 (RFC 8410): SEQUENCE { OID 1.3.101.112, BIT STRING key }.
    const prefix = Buffer.from("302a300506032b6570032100", "hex");
    const der = Buffer.concat([prefix, Buffer.from(rawKey)]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* The port                                                            */
/* ------------------------------------------------------------------ */

export class RealAuthPort implements AuthPort {
  private readonly chainIdFn: () => number;
  private readonly fetchKey: (accountId: string) => Promise<AccountKey | null>;
  private readonly nowFn: () => number;
  private readonly originFn: () => string | null;

  constructor(opts: AuthPortOpts = {}) {
    this.chainIdFn = opts.chainId ?? (() => getActiveChain().chainId);
    this.fetchKey = opts.fetchAccountKey ?? defaultFetchAccountKey;
    this.nowFn = opts.nowMs ?? (() => Date.now());
    this.originFn = opts.origin ?? requireAppOrigin;
  }

  /**
   * Verify a session credential. Two shapes:
   *  - string: a stateless session token (the per-request path) — pure
   *    HMAC + expiry, no I/O.
   *  - { message, signature }: a fresh wallet signature (the /api/auth/login
   *    path) — full cryptographic verification + nonce claim.
   */
  async verifySession(cred: unknown): Promise<VerifyResult> {
    const nowMs = this.nowFn();
    if (typeof cred === "string") {
      const r = verifySessionToken(cred, nowMs);
      if (!r.ok) return r;
      // Bind the token to the active chain: a token minted for one chain
      // must not authenticate writes on another.
      if (r.session.chainId !== this.chainIdFn()) {
        return { ok: false, error: `wrong chain (token chain ${r.session.chainId})` };
      }
      return r;
    }
    return this.verifyWalletSignature(cred, nowMs);
  }

  private async verifyWalletSignature(cred: unknown, nowMs: number): Promise<VerifyResult> {
    if (!cred || typeof cred !== "object") {
      return { ok: false, error: "missing session: sign in with your wallet" };
    }
    const { message, signature } = cred as { message?: unknown; signature?: unknown };
    if (typeof message !== "string" || typeof signature !== "string" || !message || !signature) {
      return { ok: false, error: "malformed session credential" };
    }

    const expectedChainId = this.chainIdFn();
    const v = validateSignInMessage(message, { expectedChainId, nowMs, expectedOrigin: this.originFn() });
    if (!v.ok || !v.fields) return { ok: false, error: `invalid sign-in: ${v.reason}` };
    const fields = v.fields;

    const address = canonicalAddress(fields.address);
    if (!address) return { ok: false, error: "invalid sign-in: bad address" };

    // Route by address family: 0.0.x → Hedera (Ed25519 via mirror node),
    // 0x… → EVM (personal_sign recovery).
    if (isHederaAccountId(fields.address)) {
      const key = await this.fetchKey(fields.address);
      if (!key) {
        return { ok: false, error: "could not load the wallet's public key (mirror node)" };
      }
      if (key.keyType !== "ED25519") {
        return {
          ok: false,
          error: `unsupported key type ${key.keyType}: only Ed25519 wallets can sign in on Hedera`,
        };
      }
      let sigBytes: Uint8Array;
      let keyBytes: Uint8Array;
      try {
        sigBytes = hexToBytes(signature);
        keyBytes = hexToBytes(key.keyHex);
      } catch {
        return { ok: false, error: "malformed signature or key" };
      }
      if (!verifyHederaSignature(message, sigBytes, keyBytes)) {
        return { ok: false, error: "signature does not match this wallet" };
      }
    } else {
      let recovered: string;
      try {
        recovered = ethers.verifyMessage(message, signature);
      } catch {
        return { ok: false, error: "signature does not match this wallet" };
      }
      if (recovered.toLowerCase() !== address) {
        return { ok: false, error: "signature does not match this wallet" };
      }
    }

    // Nonce single-use-ish: the same nonce with a *different* signature is
    // rejected; the identical session re-presented is fine (bearer reuse).
    // The claim lives in the shared store so every instance enforces it.
    const expiresAtMs = Date.parse(fields.expiresAt);
    let nonceError: string | null;
    try {
      nonceError = await checkNonceClaim(address, fields.nonce, signature, expiresAtMs, nowMs);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "sign-in unavailable" };
    }
    if (nonceError) {
      return { ok: false, error: nonceError };
    }

    return {
      ok: true,
      session: {
        address,
        chainId: fields.chainId,
        nonce: fields.nonce,
        expiresAtMs,
      },
    };
  }
}

let singleton: AuthPort | null = null;

/** Production port (active chain, live mirror node). */
export function defaultAuthPort(): AuthPort {
  if (!singleton) singleton = new RealAuthPort();
  return singleton;
}

/** Test helper: build a port with injected deps. */
export function testAuthPort(opts: AuthPortOpts): AuthPort {
  return new RealAuthPort(opts);
}
