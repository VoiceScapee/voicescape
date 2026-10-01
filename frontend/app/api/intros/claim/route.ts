/**
 * POST /api/intros/claim — link an agent intro to the caller's blockpage.
 *
 * Body: { claim_code: string }
 * Auth: x-vs-session header (the 7-day wallet session token, HMAC-verified
 * server-side). No payment, no chain write — this only records the link
 * between an intro and the username the wallet owns on-chain.
 *
 * Ownership check: the session's wallet address is reverse-resolved
 * through the on-chain Registry (resolveUsernameForOwner). A wallet with
 * no registered blockpage cannot claim.
 */
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { SESSION_HEADER } from "@/lib/session-message";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { resolveUsernameForOwner } from "@/lib/registry-reverse";
import { claimAgentIntro } from "@/lib/server/agent-intros";

export async function POST(req: NextRequest): Promise<Response> {
  const token = req.headers.get(SESSION_HEADER)?.trim() ?? "";
  // Agent tokens are accepted here (explicit allowlist opt-in): the
  // linked username is forced to the token's own agent — never
  // reverse-resolved, so a token can never claim another page's intro.
  const verified = await defaultAuthPort().verifySession(token || null, { allowAgent: true });
  if (!verified.ok) {
    return Response.json(
      { error: "sign in with your wallet first" },
      { status: 401 },
    );
  }

  let claimCode = "";
  try {
    const body = (await req.json()) as { claim_code?: unknown };
    claimCode = typeof body.claim_code === "string" ? body.claim_code : "";
  } catch {
    return Response.json({ error: "body must be JSON with claim_code" }, { status: 400 });
  }
  if (!claimCode.trim()) {
    return Response.json({ error: "claim_code is required" }, { status: 400 });
  }

  // Agent scope: the token's username IS the claim target. A full human
  // session keeps the existing reverse-resolve behavior.
  let username: string | null;
  if (verified.session.agent?.username) {
    username = verified.session.agent.username;
  } else {
    // The wallet must own a registered blockpage on-chain.
    username = await resolveUsernameForOwner(verified.session.address);
  }
  if (!username) {
    return Response.json(
      {
        error:
          "this wallet doesn't own a registered blockpage yet — build one first, then link your intro",
      },
      { status: 403 },
    );
  }

  const res = await claimAgentIntro(claimCode, username);
  if (!res.ok) {
    return Response.json({ error: res.error }, { status: 400 });
  }
  return Response.json({
    ok: true,
    username,
    handle: res.intro.handle,
    linked_blockpage: res.intro.linked_blockpage,
  });
}
