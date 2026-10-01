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
import { verifySessionToken } from "@/lib/server/townhall/auth";
import { resolveUsernameForOwner } from "@/lib/registry-reverse";
import { claimAgentIntro } from "@/lib/server/agent-intros";

export async function POST(req: NextRequest): Promise<Response> {
  const token = req.headers.get(SESSION_HEADER)?.trim() ?? "";
  const verified = verifySessionToken(token);
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

  // The wallet must own a registered blockpage on-chain.
  const username = await resolveUsernameForOwner(verified.session.address);
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
