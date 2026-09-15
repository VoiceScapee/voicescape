/**
 * POST /api/agent/chat — Voicescape onboarding buddy (read-only).
 *
 * Body: { message: string, history?: Array<{ role: "user"|"assistant", content: string }> }
 * Response: { reply: string }
 *
 * Buddy's brain runs on Hedera's official `@hashgraph/hedera-agent-kit`:
 * the three chain tools are the kit's `Tool` objects from the Voicescape
 * read-only plugin (`@/lib/agent/agentkit`), executed through
 * `tool.execute` — not hand-rolled copies. All tools are TOOL_TYPE.QUERY
 * (asserted at request time by getBuddyTools()); no client/operator key
 * exists anywhere in this route, so the agent can never sign, spend, or
 * publish.
 *
 * Guardrails for dapp visitors talking to Buddy:
 * - The system prompt forbids site changes outright: no editing, deleting,
 *   or configuring existing pages, posts, settings, or anyone's content,
 *   and no touching anyone's connected wallet. The one exception is the
 *   legitimate assisted build: Buddy may help a visitor plan and draft
 *   THEIR OWN blockpage, but the visitor always publishes it themselves
 *   from the builder, signing with their own wallet. Buddy never publishes
 *   for anyone.
 * - Client-supplied chat history is sanitized to user messages only, so a
 *   visitor can't inject fake "assistant" replies ("Done — I updated your
 *   page") into the context the model sees.
 * - Unknown tool names fail closed (findTool allowlist).
 *
 * Fail-closed without GROQ_API_KEY (503). In-memory per-IP rate limit
 * (20/hour → 429).
 */
import { NextRequest, NextResponse } from "next/server";
import type { Tool } from "@hashgraph/hedera-agent-kit";
import {
  findTool,
  getBuddyTools,
  toFunctionDefs,
  type BuddyContext,
} from "@/lib/agent/agentkit";
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

export const BUDDY_SYSTEM_PROMPT =
  "You are the Voicescape onboarding buddy. You help people understand " +
  "Voicescape and check real on-chain facts. You have three tools: " +
  "resolve_blockpage (is a username registered? who owns it?), verify_tip " +
  "(did a tip transaction settle?), treasury_stats (recent platform volume). " +
  "ALWAYS use a tool for on-chain facts — never invent chain data. " +
  "You are read-only: you cannot sign, spend, or publish anything, and you " +
  "never see, touch, or act on anyone's connected wallet. " +
  "You cannot change anything on the Voicescape site itself: no editing, " +
  "deleting, or configuring existing pages, posts, settings, or anyone's " +
  "content. The one thing you DO do with people is help them build THEIR " +
  "OWN blockpage: you can help plan and draft the page with them here, and " +
  "when it's ready they publish it themselves from the builder, signing " +
  "with their own wallet. You never publish for anyone. If someone asks " +
  "you to change the site or do something with their wallet, say plainly " +
  "you can't do that here and point them to the right place. " +
  "Plain language, warm, concise. Report fee numbers exactly as the tool " +
  "labels them; never reinterpret them.";

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling shape)
// ---------------------------------------------------------------------------



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

/**
 * Keep only the visitor's own messages from client-supplied history.
 * Client "assistant" messages are dropped outright: otherwise anyone could
 * inject fake Buddy replies ("Done — I updated your page") into the context
 * the model sees. The widget keeps its own display history; the model gets
 * a clean user-only transcript plus its live tool results.
 */
export function sanitizeHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m: any) => m && m.role === "user" && typeof m.content === "string")
    .slice(-6)
    .map((m: any) => ({ role: "user", content: m.content.slice(0, 2000) }));
}

async function runToolCall(
  tools: Tool[],
  call: ToolCall,
  signal: AbortSignal
): Promise<string> {
  const tool = findTool(tools, call.function.name);
  if (!tool) {
    return JSON.stringify({ error: `unknown tool: ${call.function.name}` });
  }
  let args: Record<string, unknown> = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return JSON.stringify({ error: "tool arguments were not valid JSON" });
  }
  try {
    // Zod-validated by the kit tool itself; execute returns a JSON string.
    // No Hedera client is passed — these are pure mirror-node query tools.
    const parsed = tool.parameters.parse(args);
    const out = await tool.execute(
      undefined as never,
      { signal } as BuddyContext,
      parsed
    );
    return typeof out === "string" ? out : JSON.stringify(out);
  } catch (e: any) {
    return JSON.stringify({
      error: `tool failed: ${String(e?.message ?? e).slice(0, 300)}`,
    });
  }
}

async function callGroq(
  apiKey: string,
  tools: Tool[],
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
      messages: [{ role: "system", content: BUDDY_SYSTEM_PROMPT }, ...messages],
      tools: toFunctionDefs(tools),
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
  // Guardrail: only the visitor's own words are trusted — client-supplied
  // "assistant" history is dropped by sanitizeHistory().
  const history = sanitizeHistory(body?.history);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  const signal = controller.signal;

  // Buddy's tools come from Hedera's Agent Kit (read-only Voicescape plugin).
  const tools = getBuddyTools(signal);

  try {
    const messages: ChatMessage[] = [...history, { role: "user", content: message }];
    let finalContent: string | null = null;
    let truncated = false;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const data = await callGroq(apiKey, tools, messages, signal);
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
        const content = await runToolCall(tools, call, signal);
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
