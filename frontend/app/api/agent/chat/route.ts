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
 * (asserted at build time); no client/operator key exists anywhere in this
 * route, so the agent can never sign, spend, or publish.
 *
 * Fail-closed without GROQ_API_KEY (503). In-memory per-IP rate limit
 * (20/hour → 429).
 *
 * Metered like the Agent Kit Buddy (Brandon's pricing): 5 free messages
 * per session, then 5 HBAR per 50 messages (verified on-chain via the
 * Tips contract's TipSent logs). Signed-in wallets get their own session
 * (`wallet-<address>`); anonymous visitors share the `anon` bucket. The
 * paywall check runs BEFORE the model, so denied users never burn model
 * calls — the paywall copy is returned as the reply (same UX as the ops
 * runtime). Metering state lives in the shared KvStore
 * (`@/lib/server/store`, the site's Upstash DB), namespaced `buddy:`.
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
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import {
  checkChatAccess,
  noteChatMessage,
  paywallMessage,
  type ChatAccess,
} from "@/lib/buddy/metering";
import { loadHistory, saveExchange } from "@/lib/buddy/session";

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
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
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

  // Buddy metering: wallet-scoped sessions for signed-in users, a shared
  // anonymous bucket otherwise. Checked BEFORE the model runs — denied
  // users never burn model calls. Fail closed (503) when the store is
  // unreachable: an unchecked quota must not silently become unlimited.
  let sessionId = "anon";
  let payer: string | undefined;
  try {
    const verified = await defaultAuthPort().verifySession(sessionCredentialFrom(req));
    if (verified.ok) {
      const addr = verified.session.address.toLowerCase();
      sessionId = `wallet-${addr}`;
      // Canonical 0x address — discoverPayments accepts it directly.
      payer = addr;
    }
  } catch {
    // Auth port failure: degrade to anonymous. The metering check below
    // still gates spend, and the route stays read-only.
  }

  let access: ChatAccess;
  try {
    access = await checkChatAccess(sessionId, payer);
  } catch (e) {
    console.error(
      `[agent/chat] metering unreachable: ${e instanceof Error ? e.message : String(e)}`
    );
    return NextResponse.json({ error: "chat_unavailable" }, { status: 503 });
  }
  if (!access.allowed) {
    // The paywall IS the reply — the widget just renders it (same UX as
    // the ops runtime). Anonymous visitors are pointed at connecting a
    // wallet; signed-in users at the 5 HBAR forge tip.
    return NextResponse.json({ reply: paywallMessage(!payer) }, { status: 200 });
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

  // Buddy's tools come from Hedera's Agent Kit (read-only Voicescape plugin).
  const tools = getBuddyTools(signal);

  // Server-side conversation memory (survives page reloads), merged with
  // the widget's client-side history. Every exchange is saved server-side
  // after the reply, so the two overlap — dedupe by content, bounded.
  let storedHistory: ChatMessage[] = [];
  try {
    const clientContents = new Set(history.map((m) => m.content));
    storedHistory = (await loadHistory(sessionId))
      .filter((t) => !clientContents.has(t.text))
      .slice(-10)
      .map((t) => ({
        role: t.role === "human" ? "user" : "assistant",
        content: t.text,
      }));
  } catch {
    // Memory is best-effort — a store hiccup must not break the reply.
  }

  try {
    const messages: ChatMessage[] = [
      ...storedHistory,
      ...history,
      { role: "user", content: message },
    ];
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
