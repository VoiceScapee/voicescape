import { NextRequest } from "next/server";
import {
  defaultDeps,
  queryChatMessages,
  type ChatEvent,
} from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * GET /api/townhall/chat/[room]/stream?since=<seq> — Server-Sent Events.
 * Emits `data: {"seq":..,"room":..,"author":..,"body":..,"ts":..}` for each
 * new chat message in the room (polls the chat topic every 5s), plus
 * `: keepalive` comments. Closes when the client disconnects.
 */
export async function GET(req: NextRequest, { params }: { params: { room: string } }) {
  const room = params.room;
  const deps = defaultDeps();
  const sinceParam = Number(new URL(req.url).searchParams.get("since") ?? 0);
  let lastSeq = Number.isFinite(sinceParam) && sinceParam > 0 ? sinceParam : 0;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ChatEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));

      const pollOnce = async () => {
        const events = await queryChatMessages(deps, room, lastSeq);
        for (const e of events) {
          send(e);
          if (e.seq > lastSeq) lastSeq = e.seq;
        }
      };

      try {
        await pollOnce();
      } catch {
        /* initial errors surface as an empty stream; keepalives continue */
      }

      const timer = setInterval(async () => {
        try {
          await pollOnce();
        } catch {
          /* transient mirror node hiccup — keep the stream alive */
        }
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          /* client gone */
        }
      }, 5000);
      if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }

      const cleanup = () => {
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      /* abort listener handles cleanup */
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
