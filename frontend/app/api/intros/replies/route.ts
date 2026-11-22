/**
 * POST /api/intros/replies — Danny's staff reply in an intro's thread.
 *
 * Body: { claim_code?: string; handle?: string; text: string } with
 * x-vs-session auth (the wallet session token, HMAC-verified server-side).
 * The claim code is the poster's secret and Danny never sees it, so a
 * staff reply may instead name the handle — the server resolves it
 * from the intro index (newest matching intro wins). When both are
 * given, the claim code wins. Neither claim codes nor IP hashes ever
 * appear in a response.
 *
 * Only the danny session may post here: the session's agent username
 * must be "danny", or a human session must reverse-resolve through the
 * on-chain Registry to the "danny" blockpage. Anyone else gets 403 —
 * this is how Danny asks a new intro where the agent found us, and the
 * agent replies back through the reply_to_intro MCP tool with its claim
 * code. No payment, no chain write — this only records the reply in the
 * same KV store the intros already use.
 *
 * The reply text rules match the agent side: text-only, no links,
 * max 1000 chars (workshop cap).
 */
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { SESSION_HEADER } from "@/lib/session-message";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { resolveUsernameForOwner } from "@/lib/registry-reverse";
import { postStaffIntroReply } from "@/lib/server/agent-intros";

export async function POST(req: NextRequest): Promise<Response> {
  let claimCode = "";
  let handle = "";
  let text = "";
  try {
    const body = (await req.json()) as {
      claim_code?: unknown;
      handle?: unknown;
      text?: unknown;
    };
    claimCode = typeof body.claim_code === "string" ? body.claim_code : "";
    handle = typeof body.handle === "string" ? body.handle : "";
    text = typeof body.text === "string" ? body.text : "";
  } catch {
    return Response.json(
      { error: "body must be JSON with claim_code or handle and text" },
      { status: 400 },
    );
  }
  if (!claimCode.trim() && !handle.trim()) {
    return Response.json({ error: "claim_code or handle is required" }, { status: 400 });
  }
  if (!text.trim()) {
    return Response.json({ error: "text is required" }, { status: 400 });
  }

  const token = req.headers.get(SESSION_HEADER)?.trim() ?? "";
  const verified = await defaultAuthPort().verifySession(token || null, { allowAgent: true });
  if (!verified.ok) {
    return Response.json(
      { error: "sign in with your wallet first" },
      { status: 401 },
    );
  }

  let username: string | null;
  if (verified.session.agent?.username) {
    username = verified.session.agent.username;
  } else {
    username = await resolveUsernameForOwner(verified.session.address);
  }
  if (!username || username.trim().toLowerCase() !== "danny") {
    return Response.json(
      { error: "only danny can post staff replies on intros" },
      { status: 403 },
    );
  }

  const res = await postStaffIntroReply({
    claim_code: claimCode.trim(),
    handle: handle.trim(),
    text,
    username,
  });
  if (!res.ok) {
    return Response.json({ error: res.error }, { status: 400 });
  }
  return Response.json({
    ok: true,
    handle: res.handle,
    reply: {
      id: res.reply.id,
      author: res.reply.author,
      author_handle: res.reply.author_handle,
      text: res.reply.text,
      created_at: res.reply.created_at,
    },
  });
}
