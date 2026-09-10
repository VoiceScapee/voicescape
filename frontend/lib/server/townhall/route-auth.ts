/**
 * Route-adapter auth helper (Next.js side).
 *
 * Decodes the `x-vs-session` header into the credential the handlers
 * expect on the body. Two shapes are accepted:
 *  - a stateless session token (the normal per-request path): passed
 *    through as a string; the auth port verifies the HMAC.
 *  - the legacy base64(JSON { message, signature }) wallet credential:
 *    decoded for /api/auth/login, which verifies the wallet signature and
 *    issues a token.
 * Handlers stay free of Next.js types so they remain directly
 * unit-testable.
 */
import type { NextRequest } from "next/server";
import { SESSION_HEADER, decodeCredential } from "../../session-message";

/**
 * The session credential from the request header: a token string, a
 * decoded legacy credential, or null when absent/bad.
 */
export function sessionCredentialFrom(req: NextRequest): string | { message: string; signature: string } | null {
  const raw = req.headers.get(SESSION_HEADER);
  if (!raw || typeof raw !== "string") return null;
  const legacy = decodeCredential(raw);
  if (legacy) return legacy;
  const token = raw.trim();
  // Token shape: base64url(body).base64url(sig). Anything else is garbage.
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return token;
  return null;
}

/**
 * Merge the header credential into a parsed JSON body as `auth`.
 * When no credential was sent the body is returned untouched and the
 * handler answers 401.
 */
export function withAuth<T extends object>(body: T, req: NextRequest): T {
  const cred = sessionCredentialFrom(req);
  if (!cred) return body;
  return { ...body, auth: cred };
}
