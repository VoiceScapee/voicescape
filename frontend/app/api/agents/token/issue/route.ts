import { NextRequest, NextResponse } from "next/server";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import { defaultRegistryPort } from "@/lib/server/townhall/registry-check";
import {
  AGENT_TOKEN_TTL_MS,
  AGENT_TOKEN_VERSION_TTL_MS,
  AGENT_USERNAME_RE,
  agentTokenIndexKey,
  agentTokenVersionKey,
  issueAgentToken,
} from "@/lib/server/townhall/auth";

export const runtime = "nodejs";

/**
 * POST /api/agents/token/issue — mint a scoped agent token for one of the
 * caller's AGENT pages.
 *
 * Auth: FULL human session only. Agent tokens are rejected here (the port's
 * fail-closed default) — a token can never mint another token, so there is
 * no privilege escalation.
 *
 * Body: { username: string } — must be an on-chain AGENT page owned by the
 * session wallet (verified via the Registry; ownerType/operator/purpose are
 * immutable on-chain, so this binding cannot drift).
 *
 * The token is returned ONCE in the response body — display-once semantics:
 * the human copies it to their agent immediately. It is never stored
 * server-side beyond the revocation version counter.
 *
 * Rate limit: per-IP flood gate (shared limiter, 60/hr like auth).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const gated = await ipGate(
    req,
    "agent-token-issue",
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
    // Defense in depth: should be unreachable given the port default, but
    // never let a scoped token mint another token.
    return NextResponse.json({ error: "agent tokens cannot mint new tokens" }, { status: 403 });
  }
  const session = verified.session;

  let username = "";
  try {
    const body = (await req.json()) as { username?: unknown };
    username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  } catch {
    return NextResponse.json({ error: "body must be JSON with { username }" }, { status: 400 });
  }
  if (!AGENT_USERNAME_RE.test(username)) {
    return NextResponse.json({ error: "invalid agent username" }, { status: 400 });
  }

  // On-chain binding: the username must be a registered AGENT page owned
  // by this wallet. Checked live against the Registry (cached), not
  // self-asserted.
  let page: { owner: string; ownerType: 0 | 1 } | null;
  try {
    page = await defaultRegistryPort().resolvePage(username);
  } catch {
    return NextResponse.json({ error: "registry unavailable — try again in a moment" }, { status: 503 });
  }
  if (!page) {
    return NextResponse.json(
      { error: `username "${username}" is not registered on-chain` },
      { status: 404 },
    );
  }
  if (page.ownerType !== 1) {
    return NextResponse.json(
      { error: `username "${username}" is a human page — agent tokens are only issued for AGENT pages` },
      { status: 403 },
    );
  }
  if (page.owner.toLowerCase() !== session.address.toLowerCase()) {
    return NextResponse.json(
      { error: `your wallet does not own the page "${username}"` },
      { status: 403 },
    );
  }

  // Bump the revocation version: any previously issued token for this
  // (wallet, agent) dies the moment this one is minted.
  const store = getKvStore();
  const verKey = agentTokenVersionKey(session.address, username);
  let version: number;
  try {
    const cur = await store.get(verKey);
    version = (cur ? parseInt(cur, 10) : 0) + 1;
    if (!Number.isSafeInteger(version) || version < 1) version = 1;
    await store.set(verKey, String(version), AGENT_TOKEN_VERSION_TTL_MS);
    // Maintain the per-wallet index (for revoke-all).
    const idxKey = agentTokenIndexKey(session.address);
    const rawIdx = await store.get(idxKey).catch(() => null);
    let idx: string[] = [];
    try {
      const parsed: unknown = rawIdx ? JSON.parse(rawIdx) : [];
      if (Array.isArray(parsed)) idx = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      idx = [];
    }
    if (!idx.includes(username)) {
      idx.push(username);
      await store.set(idxKey, JSON.stringify(idx.slice(0, 25)), AGENT_TOKEN_VERSION_TTL_MS);
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not issue agent token" },
      { status: 503 },
    );
  }

  const nowMs = Date.now();
  const expiresAtMs = nowMs + AGENT_TOKEN_TTL_MS;
  let token: string;
  try {
    token = issueAgentToken({
      address: session.address,
      agentUsername: username,
      chainId: session.chainId,
      expiresAtMs,
      version,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not issue agent token" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    token,
    agent: username,
    expiresAtMs,
    scope: "agent",
    note: "Copy this token to your agent now — it is shown only once. It lets the agent operate ONLY this page, expires in 7 days, and you can revoke it anytime.",
  });
}
