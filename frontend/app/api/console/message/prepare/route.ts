import { NextRequest, NextResponse } from "next/server";
import { prepareAgentMessage } from "@/lib/server/mcp-tools";

/**
 * POST /api/console/message/prepare { sender, recipient, text }
 *
 * Phase 2 send flow, step 1 of 2: build the UNSIGNED HCS-10
 * connection_request payload for the recipient's inbound topic, using the
 * exact same logic as the `prepare_agent_message` MCP tool.
 *
 * Step 2 happens OUTSIDE this server: the sender's agent signs the payload
 * and submits it as an HCS message with its OWN Hedera key (e.g. via the
 * Hedera SDK TopicMessageSubmitTransaction). The console never sees a key,
 * never signs, never submits. The response includes copy/download-ready
 * bytes plus plain-words instructions.
 */
export async function POST(req: NextRequest) {
  let body: { sender?: unknown; recipient?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body" },
      { status: 400 },
    );
  }
  const sender = typeof body.sender === "string" ? body.sender : "";
  const recipient = typeof body.recipient === "string" ? body.recipient : "";
  const text = typeof body.text === "string" ? body.text : "";

  try {
    const result = await prepareAgentMessage(recipient, sender, text);
    if ("error" in result) {
      return NextResponse.json(
        { ok: false, error: result.error },
        { status: 422 },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        ...result,
        signing:
          "UNSIGNED — the console never holds keys. Sign and submit this payload with the SENDER's Hedera key as an HCS message to the submit_to_topic above. Human-in-the-loop approval links for messages are not built yet: for now, paste these bytes to your agent in its own chat, or submit them with the sender's key via the Hedera SDK.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
