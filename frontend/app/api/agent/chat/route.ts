/**
 * POST /api/agent/chat — Voicescape onboarding buddy (read-only).
 *
 * Body: { message: string, history?: Array<{ role: "user"|"assistant", content: string }> }
 * Response: { reply: string }
 *
 * Fail-closed without GROQ_API_KEY (503). In-memory per-IP rate limit
 * (20/hour → 429). The model only reads chain data through the three
 * read-only tools in @/lib/agent/tools — it can never sign, spend, or publish.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveBlockpage, treasuryStats, verifyTip } from "@/lib/agent/tools";
import {
  agentChatClientIp,
  agentChatRateLimited,
} from "@/lib/agent/rate-limit";

export const runtime = "nodejs";

const MODEL = "openai/gpt-oss-20b";
const MAX_TOKENS = 2048;
const MAX_ITERATIONS = 5;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const AGENT_TIMEOUT_MS = 25_000;

const SYSTEM_PROMPT =
  "You are the Voicescape onboarding buddy. You help people understand " +
  "Voicescape and check real on-chain facts. You have three tools: " +
  "resolve_blockpage (is a username registered? who owns it?), verify_tip " +
  "(did a tip transaction settle?), treasury_stats (recent platform volume). " +
  "ALWAYS use a tool for on-chain facts — never invent chain data. You are " +
  "read-only: you cannot sign, spend, or publish anything. If the user wants " +
  "to publish or pay, explain they connect their own wallet and sign. " +
  "Plain language, warm, concise. Report fee numbers exactly as the tool " +
  "labels them; never reinterpret them.";

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling shape)
// ---------------------------------------------------------------------------

const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "resolve_blockpage",
      description:
        "Check whether a Voicescape username is registered on-chain. Returns the owner account, owner type (human/agent), IPFS hash, operator, and purpose. Read-only.",
      parameters: {
        type: "object",
        properties: {
          username: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            description: "Voicescape blockpage username, e.g. 'forge'",
          },
        },
        required: ["username"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verify_tip",
      description:
        "Verify a tip/payment transaction on Hedera mainnet. Reports success, HBAR amounts, the recipient, whether the Tips contract was called, and the called function. Read-only.",
      parameters: {
        type: "object",
        properties: {
          transactionId: {
            type: "string",
            pattern: "^\\d+\\.\\d+\\.\\d+-\\d+-\\d+$",
            description:
              "Mirror node transaction id, e.g. '0.0.10424063-1789415526-674972740'",
          },
        },
        required: ["transactionId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "treasury_stats",
      description:
        "Recent tip volume through the Voicescape Tips contract over a lookback window in hours. Read-only.",
      parameters: {
        type: "object",
        properties: {
          hoursBack: {
            type: "integer",
            minimum: 1,
            maximum: 168,
            default: 24,
            description: "Lookback window in hours",
          },
        },
        additionalProperties: false,
      },
    },
  },
] as const;

type ToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

type ChatMessage = {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

async function runToolCall(call: ToolCall, signal: AbortSignal): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return JSON.stringify({ error: "tool arguments were not valid JSON" });
  }
  try {
    switch (call.function.name) {
      case "resolve_blockpage":
        return JSON.stringify(await resolveBlockpage(String(args.username ?? ""), signal));
      case "verify_tip":
        return JSON.stringify(await verifyTip(String(args.transactionId ?? ""), signal));
      case "treasury_stats": {
        const h = Number(args.hoursBack ?? 24);
        return JSON.stringify(await treasuryStats(Number.isFinite(h) ? h : 24, signal));
      }
      default:
        return JSON.stringify({ error: `unknown tool: ${call.function.name}` });
    }
  } catch (e: any) {
    return JSON.stringify({
      error: `tool failed: ${String(e?.message ?? e).slice(0, 300)}`,
    });
  }
}

async function callGroq(
  apiKey: string,
  messages: ChatMessage[],
  signal: AbortSignal
): Promise<any> {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      // Real User-Agent: the API sits behind Cloudflare bot screening and
      // rejects default-library user agents with HTTP 403 (error 1010).
      "user-agent": "VoicescapeAgent/1.0 (+https://voicescape.vercel.app)",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      tools: TOOL_DEFS,
    }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`groq HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const apiKey = process.env.GROQ_API_KEY;
  // Fail closed: no key, no chat. Never log or echo the key.
  if (!apiKey) {
    return NextResponse.json({ error: "chat_unavailable" }, { status: 503 });
  }

  if (agentChatRateLimited(agentChatClientIp(req))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const message = String(body?.message ?? "").slice(0, 2000).trim();
  if (!message) {
    return NextResponse.json({ error: "message_required" }, { status: 400 });
  }
  const rawHistory = Array.isArray(body?.history) ? body.history.slice(-6) : [];
  const history: ChatMessage[] = rawHistory
    .filter(
      (m: any) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 2000) }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  const signal = controller.signal;

  try {
    const messages: ChatMessage[] = [...history, { role: "user", content: message }];
    let finalContent: string | null = null;
    let truncated = false;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const data = await callGroq(apiKey, messages, signal);
      const choice = data?.choices?.[0];
      const msg = choice?.message;
      if (!msg) throw new Error("groq response had no choices[0].message");
      // gpt-oss puts chain-of-thought in a separate `reasoning` field; the
      // visible answer is always `content`. We ignore `reasoning`.
      if (choice.finish_reason === "length") truncated = true;

      const toolCalls: ToolCall[] = msg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        finalContent = msg.content ?? "";
        break;
      }
      messages.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: toolCalls,
      });
      for (const call of toolCalls) {
        const content = await runToolCall(call, signal);
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }

    if (finalContent === null) {
      finalContent =
        "I got stuck checking the chain — try rephrasing your question.";
    }
    if (truncated) finalContent += " (note: my answer was cut short)";
    return NextResponse.json({ reply: finalContent });
  } catch (e: any) {
    const aborted = signal.aborted;
    return NextResponse.json(
      { error: aborted ? "chat_timeout" : "chat_failed" },
      { status: aborted ? 504 : 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}
