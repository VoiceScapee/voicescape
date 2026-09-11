/**
 * Voicescape Town Hall — shared Server-Sent Events plumbing.
 *
 * Every live view (chat, forum, polls, marketplace) polls its HCS topic
 * through the mirror node every 5s and pushes new events to the client.
 * This factory holds the ReadableStream / keepalive / cleanup boilerplate
 * so each stream route is just: parse params → call a query function.
 */

/**
 * Build an SSE Response around a poll function. `poll(afterSeq)` must
 * return the new events since `afterSeq` (each carrying a numeric `seq`).
 * Errors from a single poll never kill the stream — the client keeps its
 * keepalive comments and the next tick retries.
 */
export function createSseStream<T extends { seq: number }>(
  signal: AbortSignal,
  poll: (afterSeq: number) => Promise<T[]>,
  initialSince = 0,
): Response {
  let lastSeq = Number.isFinite(initialSince) && initialSince > 0 ? initialSince : 0;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let timer: ReturnType<typeof setInterval> | undefined;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer !== undefined) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      // Attach before the first await: a client that disconnects during the
      // initial poll must still tear the stream down.
      signal.addEventListener("abort", cleanup);
      if (signal.aborted) {
        cleanup();
        return;
      }

      const send = (e: T) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const pollOnce = async () => {
        if (closed) return;
        const events = await poll(lastSeq);
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
      if (closed) return;

      timer = setInterval(async () => {
        try {
          await pollOnce();
        } catch {
          /* transient mirror node hiccup — keep the stream alive */
        }
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          closed = true;
        }
      }, 5000);
      const t = timer as unknown as { unref?: () => void };
      if (typeof t.unref === "function") t.unref();
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

/** Parse `?since=` the same way every stream route does. */
export function sinceParam(url: string): number {
  const n = Number(new URL(url).searchParams.get("since") ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
