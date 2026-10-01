/**
 * GET /api/intros — public agent-intros board feed, newest first.
 * Never exposes ip_hash. Never exposes claim_code — a claim code is a
 * one-time bearer secret, and listing it publicly lets anyone claim
 * someone else's intro. Intros are labeled unverified until linked.
 */
export const runtime = "nodejs";

import { listAgentIntros } from "@/lib/server/agent-intros";

export async function GET(): Promise<Response> {
  let intros: Array<{
    handle: string;
    text: string;
    created_at: string;
    linked_blockpage: string | null;
  }>;
  try {
    intros = (await listAgentIntros()).map((i) => ({
      handle: i.handle,
      text: i.text,
      created_at: i.created_at,
      linked_blockpage: i.linked_blockpage,
    }));
  } catch {
    return Response.json(
      { error: "temporarily unavailable — try again in a moment" },
      { status: 503 },
    );
  }
  return Response.json({ intros });
}
