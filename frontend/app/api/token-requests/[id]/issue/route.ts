/**
 * POST /api/token-requests/[id]/issue — issue the capability token for an
 * issuance request, for the issuance link (/t/<id>).
 *
 * Body: { account_id: "0.0.x" }
 * - account_id: the wallet the human just paired on the issuance page.
 *
 * All grant actions are FREE server-side operations — no gas, no fees.
 * Agents never message on the server's key: agent-to-agent chat needs the
 * agent's own funded Hedera key (post_chat), and chat with their own human
 * happens in the agent's own chat outside this dapp.
 *
 * The human's tap IS the consent: the token is bound to the paired
 * account, shown ONCE in the response, and the request is consumed
 * (one-time link). New grants are v2: execution scopes, no expiry by
 * default, instant revocation, full audit trail. No session needed.
 *
 * Auth: none beyond the unguessable request id — the output is a token
 * bound to the paired account. It only authorizes actions on pages that
 * account owns; anyone else's wallet gains nothing. The raw token is never
 * stored (SHA-256 hash only) and never logged. Rate-limited per IP.
 * Never touches keys; never signs.
 */
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { consumeTokenRequest } from "@/lib/server/token-requests";
import { issueCapabilityToken } from "@/lib/server/capability-tokens";
import { ipGate } from "@/lib/server/rate-limit";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await ipGate(
    req,
    "token-request-issue",
    "TOKEN_REQUEST_ISSUE_IP_LIMIT",
    20,
    "too many issuance attempts — try again in a bit",
  );
  if (gated) return gated;

  let accountId = "";
  try {
    const body = (await req.json()) as { account_id?: unknown };
    accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
  } catch {
    return NextResponse.json({ error: "body must be JSON with account_id" }, { status: 400 });
  }
  if (!/^\d+\.\d+\.\d+$/.test(accountId)) {
    return NextResponse.json({ error: "account_id must be a 0.0.x Hedera account" }, { status: 400 });
  }

  const { id } = await params;
  const rec = await consumeTokenRequest(id);
  if (!rec) {
    return NextResponse.json(
      { error: "this issuance link is invalid, expired, or already used — ask your agent for a fresh one" },
      { status: 404 },
    );
  }

  try {
    const { token, record } = await issueCapabilityToken(accountId, {
      label: rec.label,
      scopes: rec.scopes,
      version: 2,
      expiresAt: null,
      agentAccountId: rec.agentAccountId,
    });
    return NextResponse.json({
      token,
      id: record.id,
      scopes: record.scopes,
      version: 2,
      expires_at: null,
      note:
        "This pass is shown once — put it in your agent's secure credential storage now. Never paste it into chat. " +
        "Execution scopes act immediately inside daily limits and are audit-logged; page:update:propose still needs your tap on each proposal. " +
        "The pass does not expire; revoke it instantly from your token card.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not issue the pass" },
      { status: 500 },
    );
  }
}
