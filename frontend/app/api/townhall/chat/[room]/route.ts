import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/server/townhall/route-auth";
import { ipGate } from "@/lib/server/rate-limit";
import { defaultDeps, postChat, queryChatMessages, type PostChatBody } from "@/lib/server/townhall/handlers";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { verifySessionToken } from "@/lib/server/townhall/auth";
import { BUILDERS_ROOM_ID, BUILDER_UNLOCK_MESSAGE, hasBuilderBadge } from "@/lib/server/badges";

export const runtime = "nodejs";

/**
 * GET /api/townhall/chat/[room]?since=<seq> — JSON polling endpoint.
 * Returns {messages: ChatEvent[]} for the polling fallback in useStreamEvents.
 * The SSE stream endpoint keeps connections open indefinitely, which breaks
 * the polling fallback (it aborts after 4.5s and loses the data). This
 * endpoint returns immediately with JSON.
 */
export async function GET(req: NextRequest, { params }: { params: { room: string } }) {
  try {
    const room = params.room;
    // Builders room gating (same as stream endpoint).
    if (room === BUILDERS_ROOM_ID) {
      const cred = sessionCredentialFrom(req);
      const verified = typeof cred === "string" ? verifySessionToken(cred) : null;
      if (!verified || !verified.ok) {
        return NextResponse.json(
          { error: verified && !verified.ok ? verified.error : "missing session: sign in with your wallet" },
          { status: 401 },
        );
      }
      if (!(await hasBuilderBadge(verified.session.address))) {
        return NextResponse.json({ error: BUILDER_UNLOCK_MESSAGE }, { status: 403 });
      }
    }
    const url = new URL(req.url);
    const since = parseInt(url.searchParams.get("since") || "0", 10);
    // Bypass the HCS cache — query the mirror node directly to ensure
    // fresh data. The cache was returning stale empty results.
    const { getTopicId, mirrorBaseUrl } = await import("@/lib/server/townhall/topics");
    const topic = getTopicId("chat");
    if (!topic) return NextResponse.json({ messages: [] });
    const mirrorUrl = `${mirrorBaseUrl()}/api/v1/topics/${topic}/messages?order=asc&limit=100${Number.isFinite(since) && since > 0 ? `&sequencenumber=gt:${since}` : ""}`;
    const res = await fetch(mirrorUrl);
    if (!res.ok) throw new Error(`Mirror node query failed: ${res.status}`);
    const data = (await res.json()) as { messages?: Array<{ sequence_number: number; message: string }> };
    const messages = [];
    for (const m of data.messages ?? []) {
      try {
        const parsed = JSON.parse(Buffer.from(m.message, "base64").toString("utf8"));
        if (parsed.v === 1 && parsed.kind === "chat" && parsed.room === room) {
          messages.push({
            seq: m.sequence_number,
            room: parsed.room,
            author: parsed.author,
            body: parsed.body,
            ts: parsed.ts,
          });
        }
      } catch {
        // skip malformed
      }
    }
    return NextResponse.json({ messages });
  } catch (e) {
    console.error("[chat GET] error:", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: "Failed to load messages" }, { status: 500 });
  }
}

/**
 * POST /api/townhall/chat/[room] {author,body,dustFeeTxId}
 * Dust fee required. 201 → {seq}.
 */
export async function POST(req: NextRequest, { params }: { params: { room: string } }) {
  // Per-IP flood bound in front of the per-wallet quotas and dust fees.
  const gated = await ipGate(
    req,
    "townhall",
    "IP_RATE_LIMIT_TOWNHALL",
    300,
    "too many town hall writes from this network — try again later",
  );
  if (gated) return gated;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { status, json } = await postChat(defaultDeps(), params.room, withAuth((body ?? {}) as PostChatBody, req));
  return NextResponse.json(json, { status });
}
