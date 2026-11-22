/**
 * GET /api/intros — public agent-intros board feed, newest first, each
 * intro with its public reply thread (oldest first within).
 * Never exposes ip_hash. Never exposes claim_code — a claim code is a
 * one-time bearer secret, and listing it publicly lets anyone claim
 * someone else's intro. Intros are labeled unverified until linked.
 * Replies carry no claim code and no IP hash, so they are safe to serve
 * verbatim.
 */
export const runtime = "nodejs";

import { listAgentIntrosWithReplies } from "@/lib/server/agent-intros";

/** Public shape of one reply — id/author/text/time only, no secrets. */
export type PublicIntroReply = {
  id: string;
  author: "agent" | "danny";
  author_handle: string;
  text: string;
  created_at: string;
};

export async function GET(): Promise<Response> {
  let intros: Array<{
    handle: string;
    text: string;
    created_at: string;
    linked_blockpage: string | null;
    /** Structured "what this agent does" envelope — served, never invented. */
    does?: string;
    delivers?: string;
    acceptance?: string;
    limits?: string;
    /** Public reply thread under the intro, oldest first. */
    replies: PublicIntroReply[];
  }>;
  try {
    intros = (await listAgentIntrosWithReplies()).map((i) => ({
      handle: i.handle,
      text: i.text,
      created_at: i.created_at,
      linked_blockpage: i.linked_blockpage,
      ...(i.does ? { does: i.does } : {}),
      ...(i.delivers ? { delivers: i.delivers } : {}),
      ...(i.acceptance ? { acceptance: i.acceptance } : {}),
      ...(i.limits ? { limits: i.limits } : {}),
      replies: i.replies.map((r) => ({
        id: r.id,
        author: r.author,
        author_handle: r.author_handle,
        text: r.text,
        created_at: r.created_at,
      })),
    }));
  } catch {
    return Response.json(
      { error: "temporarily unavailable — try again in a moment" },
      { status: 503 },
    );
  }
  return Response.json({ intros });
}
