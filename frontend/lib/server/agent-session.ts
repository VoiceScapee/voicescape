/**
 * agent-session — session auth for the chat-adjacent agent routes
 * (/api/agents/overview, /api/agents/proposals).
 *
 * Returns the signed-in wallet's Hedera account id in "0.0.x" form, or null
 * when the request carries no valid session. The dashboard and the approval
 * inbox are strictly per-owner: no session, no data.
 */
import type { NextRequest } from "next/server";
import { sessionCredentialFrom } from "./townhall/route-auth";
import { verifySessionToken } from "./townhall/auth";

export async function agentOwnerFromRequest(req: NextRequest): Promise<string | null> {
  const cred = sessionCredentialFrom(req);
  if (typeof cred !== "string") return null;
  const verified = verifySessionToken(cred);
  if (!verified || !verified.ok) return null;
  const addr = (verified.session.address ?? "").trim();
  const m = /^0x([0-9a-fA-F]{40})$/.exec(addr);
  if (!m) return null;
  return `0.0.${BigInt("0x" + m[1]).toString(10)}`;
}
