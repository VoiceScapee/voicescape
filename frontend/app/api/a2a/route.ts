import { NextRequest, NextResponse } from "next/server";
import { ipGate } from "@/lib/server/rate-limit";
import {
  answerMessage,
  buildStreamEvents,
  handleA2A,
  isStreamMethod,
} from "@/lib/a2a/handler";

/**
 * POST /api/a2a — A2A JSON-RPC 2.0 endpoint for agent onboarding Q&A.
 *
 * Spec: A2A Protocol v1.0.0 (Linux Foundation), §5.3 method mapping.
 * Accepts both v1.0 PascalCase methods (SendMessage, SendStreamingMessage,
 * GetTask, ListTasks, CancelTask) and the legacy v0.3 wire names
 * (message/send, message/stream, tasks/get, tasks/list, tasks/cancel).
 *
 * This endpoint is READ-ONLY: it answers onboarding questions from the
 * app's real routes/docs. No secrets, no chain writes, no money movement.
 *
 * Guardrails: per-IP flood gate (same middleware as the other public
 * agent endpoints). The task store is in-memory and bounded — see
 * lib/a2a/handler.ts.
 */
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const gated = await ipGate(
    req,
    "a2a",
    "IP_RATE_LIMIT_A2A",
    60,
    "too many A2A requests from this network — try again later",
  );
  if (gated) return gated;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 200 },
    );
  }

  // Streaming form: answer synchronously, then emit the A2A §6.2 SSE
  // event sequence (task/working → artifact update → status/completed).
  if (isStreamMethod(body)) {
    const params = ((body as { params?: Record<string, unknown> }).params ?? {}) as Record<
      string,
      unknown
    >;
    const task = answerMessage(params);
    const events = buildStreamEvents(task);
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of events) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  return NextResponse.json(handleA2A(body));
}

export async function GET() {
  return NextResponse.json(
    {
      error:
        "A2A JSON-RPC lives at POST /api/a2a — discover the agent at /.well-known/agent-card.json",
    },
    { status: 405 },
  );
}
