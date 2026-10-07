/**
 * /api/agents/tokens — capability-token management for keyless agents.
 *
 * Session-authenticated (x-vs-session); strictly per-owner. The human's
 * wallet session IS the consent: issuing a token requires their signed-in
 * session, which is the consent record the capability model asks for.
 *
 * POST   { label, scopes? } → { token, id, expires_at } — the raw token is
 *          shown ONCE. Never retrievable afterwards.
 * GET    → { tokens: [{ id, label, scopes, created_at, expires_at, last_used_at }] }
 * DELETE { id } → { revoked: true }
 *
 * A capability token is NOT a key: it cannot sign anything. It only lets a
 * keyless agent SUBMIT page-update proposals to this human's approval
 * inbox. Every on-chain write still needs the human's wallet signature.
 */
import { NextRequest, NextResponse } from "next/server";
import { agentOwnerFromRequest } from "@/lib/server/agent-session";
import {
  issueCapabilityToken,
  listCapabilityTokens,
  revokeCapabilityToken,
  CAPABILITY_SCOPES,
  type CapabilityScope,
} from "@/lib/server/capability-tokens";
import { ipGate } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

function publicRecord(r: {
  id: string;
  label: string;
  scopes: CapabilityScope[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
}) {
  return {
    id: r.id,
    label: r.label,
    scopes: r.scopes,
    created_at: r.createdAt,
    expires_at: r.expiresAt,
    last_used_at: r.lastUsedAt,
  };
}

export async function POST(req: NextRequest) {
  const gated = await ipGate(req, "cap-token-issue", "CAP_TOKEN_ISSUE_IP_LIMIT", 20, "too many token requests — try again in a bit");
  if (gated) return gated;
  const owner = await agentOwnerFromRequest(req);
  if (!owner) return NextResponse.json({ error: "sign in required" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    label?: unknown;
    scopes?: unknown;
  } | null;
  const label = typeof body?.label === "string" ? body.label : "";
  let scopes: CapabilityScope[] | undefined;
  if (body?.scopes !== undefined) {
    if (
      !Array.isArray(body.scopes) ||
      !body.scopes.every((s): s is CapabilityScope => (CAPABILITY_SCOPES as readonly string[]).includes(s as string))
    ) {
      return NextResponse.json(
        { error: `scopes must be a subset of: ${CAPABILITY_SCOPES.join(", ")}` },
        { status: 400 },
      );
    }
    scopes = body.scopes as CapabilityScope[];
  }

  try {
    const { token, record } = await issueCapabilityToken(owner, { label, scopes });
    return NextResponse.json({
      token,
      id: record.id,
      scopes: record.scopes,
      expires_at: record.expiresAt,
      note: "This token is shown once — store it in secure credential storage. It cannot sign anything; it only lets your agent propose page updates for your approval.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not issue token" },
      { status: 400 },
    );
  }
}

export async function GET(req: NextRequest) {
  const owner = await agentOwnerFromRequest(req);
  if (!owner) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const tokens = await listCapabilityTokens(owner);
  return NextResponse.json({ tokens: tokens.map(publicRecord) });
}

export async function DELETE(req: NextRequest) {
  const owner = await agentOwnerFromRequest(req);
  if (!owner) return NextResponse.json({ error: "sign in required" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const revoked = await revokeCapabilityToken(owner, id);
  if (!revoked) return NextResponse.json({ error: "token not found" }, { status: 404 });
  return NextResponse.json({ revoked: true, note: "Revocation is instant — the next proposal attempt with this token fails closed." });
}
