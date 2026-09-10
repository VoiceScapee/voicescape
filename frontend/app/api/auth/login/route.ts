import { NextRequest, NextResponse } from "next/server";
import { defaultAuthPort, issueSessionToken } from "@/lib/server/townhall/auth";

export const runtime = "nodejs";

/**
 * POST /api/auth/login — exchange a fresh wallet signature for a
 * stateless session token.
 *
 * Body: { credential: { message, signature } } (or the raw credential).
 *
 * Runs the full cryptographic verification once: EVM sessions via
 * ecrecover, Hedera sessions via the mirror-node account key, plus
 * EIP-4361 origin binding and nonce claim. On success returns a
 * 7-day HMAC-signed session token — subsequent requests carry the token
 * in the `x-vs-session` header and are verified without I/O or server
 * state. This is what surfaces connect-only wallets with a clear error
 * instead of a session that 401s on every write.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const credential =
    (body as { credential?: unknown } | null)?.credential !== undefined
      ? (body as { credential: unknown }).credential
      : body;
  if (
    !credential ||
    typeof credential !== "object" ||
    typeof (credential as { message?: unknown }).message !== "string" ||
    typeof (credential as { signature?: unknown }).signature !== "string"
  ) {
    return NextResponse.json(
      { ok: false, error: "expected { credential: { message, signature } }" },
      { status: 400 },
    );
  }
  let result;
  try {
    result = await defaultAuthPort().verifySession(credential);
  } catch (e) {
    // Fail-closed config (SESSION_SECRET / APP_ORIGIN missing in prod).
    const message = e instanceof Error ? e.message : "sign-in unavailable";
    console.error(`[auth] login failed closed: ${message}`);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 401 });
  }
  let token: string;
  try {
    token = issueSessionToken(result.session);
  } catch (e) {
    const message = e instanceof Error ? e.message : "could not issue session";
    console.error(`[auth] token issuance failed: ${message}`);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    token,
    session: {
      address: result.session.address,
      chainId: result.session.chainId,
      expiresAtMs: result.session.expiresAtMs,
    },
  });
}
