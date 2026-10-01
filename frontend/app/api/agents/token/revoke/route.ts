import { NextRequest, NextResponse } from "next/server";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import {
  AGENT_TOKEN_VERSION_TTL_MS,
  AGENT_USERNAME_RE,
  agentTokenIndexKey,
  agentTokenVersionKey,
} from "@/lib/server/townhall/auth";

export const runtime = "nodejs";

/**
 * POST /api/agents/token/revoke — instantly kill agent tokens.
 *
 * Auth: FULL human session only. Agent tokens are rejected here (the
 * port's fail-closed default) — a token can never revoke or re-mint,
 * so a compromised agent cannot lock out its human or mint fresh
 * tokens for itself.
 *
 * Body: { username: string } revokes every outstanding token for that
 * agent page, or { all: true } revokes every agent token on the wallet.
 * Revocation bumps the KV revocation version; outstanding tokens fail
 * their version check on next use. The version key outlives the
 * longest token it can invalidate (8d TTL vs 7d token), so a revoked
 * token can never become valid again by key expiry.
 *
 * Rate limit: per-IP flood gate (shared limiter, 60/hr like auth).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const gated = await ipGate(
    req,
    "agent-token-revoke",
    "IP_RATE_LIMIT_AGENT_TOKEN",
    60,
    "too many agent-token requests from this network — try again later",
  );
  if (gated) return gated;

  // Full session only — agent tokens rejected by the port default.
  const verified = await defaultAuthPort().verifySession(sessionCredentialFrom(req));
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  if (verified.session.agent) {
    // Defense in depth: unreachable given the port default, but a scoped
    // token must never be able to revoke (or re-mint) tokens.
    return NextResponse.json({ error: "agent tokens cannot revoke tokens" }, { status: 403 });
  }
  const session = verified.session;

  let body: { username?: unknown; all?: unknown };
  try {
    body = (await req.json()) as { username?: unknown; all?: unknown };
  } catch {
    return NextResponse.json({ error: "body must be JSON with { username } or { all: true }" }, { status: 400 });
  }

  const revokeAll = body.all === true;
  let usernames: string[];
  if (revokeAll) {
    usernames = [];
  } else {
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    if (!AGENT_USERNAME_RE.test(username)) {
      return NextResponse.json({ error: "invalid agent username" }, { status: 400 });
    }
    usernames = [username];
  }

  const store = getKvStore();
  try {
    if (revokeAll) {
      // Resolve the wallet's agent index (best-effort: a missing index
      // just means nothing was ever issued).
      const rawIdx = await store.get(agentTokenIndexKey(session.address)).catch(() => null);
      let idx: string[] = [];
      try {
        const parsed: unknown = rawIdx ? JSON.parse(rawIdx) : [];
        if (Array.isArray(parsed)) idx = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        idx = [];
      }
      usernames = idx.slice(0, 25);
    }
    const revoked: string[] = [];
    for (const username of usernames) {
      const verKey = agentTokenVersionKey(session.address, username);
      const cur = await store.get(verKey).catch(() => null);
      const next = (cur ? parseInt(cur, 10) : 0) + 1;
      await store.set(verKey, String(Number.isSafeInteger(next) && next > 0 ? next : 1), AGENT_TOKEN_VERSION_TTL_MS);
      revoked.push(username);
    }
    return NextResponse.json({
      ok: true,
      revoked,
      note:
        revoked.length === 0
          ? "No agent tokens were outstanding for this wallet."
          : "Outstanding tokens for the listed agent pages are now invalid.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not revoke agent token" },
      { status: 503 },
    );
  }
}
