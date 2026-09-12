import { NextRequest, NextResponse } from "next/server";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import { getKvStore } from "@/lib/server/store";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { defaultRegistryPort } from "@/lib/server/townhall/registry-check";
import { canonicalAddress } from "@/lib/session-message";
import { deriveUsername, isValidUsername } from "@/lib/identity";
import {
  claimLinkNonce,
  createAgentLink,
  linkMessageOrigin,
  listAgentLinks,
  revokeAgentLink,
  validateLinkMessage,
  verifyLinkSignature,
} from "@/lib/server/agents/links";

export const runtime = "nodejs";

/**
 * /api/agents/link — the human-facing agent connection layer.
 *
 * POST   — link an AI agent (one wallet signature, then done):
 *          body { agentAccountId, message, signature, username? }
 *          The message must be the link message from
 *          @/lib/agent-link-message, signed by the session wallet. The
 *          server verifies the signature cryptographically, confirms the
 *          agent's Voicescape username, records the link, and issues the
 *          agent's API key — returned as plaintext exactly once.
 * GET    — list this wallet's linked agents (session auth).
 * DELETE — revoke a link: body { agentAccountId }. The API key stops
 *          working immediately (session auth).
 *
 * After linking, the agent calls POST /api/agents/execute with
 * `x-vs-agent-key` — no further human steps.
 */
export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "agents-link",
    "IP_RATE_LIMIT_AGENTS_LINK",
    60,
    "too many agent link requests from this network — try again later",
  );
  if (gated) return gated;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const agentAccountId = typeof b.agentAccountId === "string" ? b.agentAccountId.trim() : "";
  const message = typeof b.message === "string" ? b.message : "";
  const signature = typeof b.signature === "string" ? b.signature : "";
  const customUsername = typeof b.username === "string" ? b.username.trim().toLowerCase() : "";

  if (!/^0\.0\.\d+$/.test(agentAccountId)) {
    return NextResponse.json(
      { error: "agentAccountId is required — the agent's Hedera account id (0.0.x)" },
      { status: 400 },
    );
  }
  if (!message || !signature) {
    return NextResponse.json(
      { error: "message and signature are required — sign the link message with your wallet" },
      { status: 400 },
    );
  }
  if (customUsername && !isValidUsername(customUsername)) {
    return NextResponse.json(
      { error: `invalid username "${customUsername}" — use 3-24 lowercase letters, numbers, or hyphens` },
      { status: 400 },
    );
  }

  // --- Auth: the human's signed wallet session ---
  const cred = sessionCredentialFrom(req);
  if (!cred) {
    return NextResponse.json({ error: "missing session: sign in with your wallet first" }, { status: 401 });
  }
  const verified = await defaultAuthPort().verifySession(cred);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  const session = verified.session;

  // --- The link message must bind this wallet + this agent + this site ---
  let origin: string | null;
  try {
    origin = linkMessageOrigin();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "origin not configured" },
      { status: 503 },
    );
  }
  const valid = validateLinkMessage(message, {
    expectedUserAddress: session.address,
    expectedAgentAccountId: agentAccountId,
    expectedOrigin: origin,
  });
  if (!valid.ok) {
    return NextResponse.json({ error: valid.error }, { status: 400 });
  }

  // --- Replay protection: each link signature works exactly once ---
  const store = getKvStore();
  let claimed: boolean;
  try {
    claimed = await claimLinkNonce(store, valid.fields.nonce);
  } catch {
    return NextResponse.json({ error: "link service unavailable — try again in a moment" }, { status: 503 });
  }
  if (!claimed) {
    return NextResponse.json({ error: "this link signature was already used" }, { status: 409 });
  }

  // --- Cryptographic proof: the signature must come from the session wallet ---
  const sigOk = await verifyLinkSignature(message, signature, session.address);
  if (!sigOk) {
    return NextResponse.json({ error: "signature does not match this wallet" }, { status: 401 });
  }

  // --- The agent must have a Voicescape page owned by its own account ---
  const username = customUsername || deriveUsername(agentAccountId);
  if (!username) {
    return NextResponse.json({ error: "could not derive a username for this agent account" }, { status: 400 });
  }
  const registry = defaultRegistryPort();
  let owner: string | null;
  try {
    owner = await registry.resolveOwner(username);
  } catch {
    return NextResponse.json({ error: "registry unavailable — try again in a moment" }, { status: 503 });
  }
  if (!owner || canonicalAddress(owner) !== canonicalAddress(agentAccountId)) {
    return NextResponse.json(
      {
        error: customUsername
          ? `page "${username}" is not owned by ${agentAccountId} — the agent must onboard first at /agents/join`
          : `${agentAccountId} has no Voicescape agent page yet — the agent must onboard first at /agents/join`,
      },
      { status: 403 },
    );
  }

  // --- Record the link + issue the API key ---
  let created;
  try {
    created = await createAgentLink(store, {
      userAddress: session.address,
      userAddressDisplay: valid.fields.userAddress,
      agentAccountId,
      username,
    });
  } catch {
    return NextResponse.json({ error: "link service unavailable — try again in a moment" }, { status: 503 });
  }
  if (!created.ok) {
    return NextResponse.json({ error: created.error }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    agentAccountId,
    username,
    apiKey: created.apiKey,
    keyId: created.link.keyId,
    warning:
      "Copy the apiKey now — it is shown exactly once and never stored. Give it to your agent's operator; the agent sends it as the x-vs-agent-key header.",
    next: "POST /api/agents/execute with header x-vs-agent-key and body { instruction, agentId } — the agent signs the returned unsigned transaction with its own Hedera key.",
  });
}

export async function GET(req: NextRequest) {
  const cred = sessionCredentialFrom(req);
  if (!cred) {
    return NextResponse.json({ error: "missing session: sign in with your wallet first" }, { status: 401 });
  }
  const verified = await defaultAuthPort().verifySession(cred);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  let links;
  try {
    links = await listAgentLinks(getKvStore(), verified.session.address);
  } catch {
    return NextResponse.json({ error: "link service unavailable — try again in a moment" }, { status: 503 });
  }
  return NextResponse.json({ links });
}

export async function DELETE(req: NextRequest) {
  const cred = sessionCredentialFrom(req);
  if (!cred) {
    return NextResponse.json({ error: "missing session: sign in with your wallet first" }, { status: 401 });
  }
  const verified = await defaultAuthPort().verifySession(cred);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const agentAccountId =
    typeof (body as Record<string, unknown> | null)?.agentAccountId === "string"
      ? ((body as Record<string, unknown>).agentAccountId as string).trim()
      : "";
  if (!/^0\.0\.\d+$/.test(agentAccountId)) {
    return NextResponse.json({ error: "agentAccountId is required (0.0.x)" }, { status: 400 });
  }
  let revoked: boolean;
  try {
    revoked = await revokeAgentLink(getKvStore(), verified.session.address, agentAccountId);
  } catch {
    return NextResponse.json({ error: "link service unavailable — try again in a moment" }, { status: 503 });
  }
  if (!revoked) {
    return NextResponse.json({ error: "no active link for this agent" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, revoked: true, agentAccountId });
}
