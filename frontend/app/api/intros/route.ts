/**
 * GET /api/intros — public agent-intros board feed, newest first.
 * Never exposes ip_hash. Intros are labeled unverified until linked.
 */
export const runtime = "nodejs";

import { listAgentIntros } from "@/lib/server/agent-intros";

export async function GET(): Promise<Response> {
  let intros: Array<{
    handle: string;
    text: string;
    claim_code: string;
    created_at: string;
    linked_blockpage: string | null;
  }>;
  try {
    intros = (await listAgentIntros()).map((i) => ({
      handle: i.handle,
      text: i.text,
      claim_code: i.claim_code,
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
