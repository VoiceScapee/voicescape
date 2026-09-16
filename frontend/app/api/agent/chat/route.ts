/**
 * POST /api/agent/chat — Voicescape onboarding buddy (read-only).
 *
 * Body: { message: string, history?: Array<{ role: "user"|"assistant", content: string }>,
 *          build_state?: string }
 * Response: { reply: string, build_state: string }
 *
 * build_state is the server's HMAC-signed build-progress token (see
 * ./build-state.ts): the widget echoes it back each turn so the model can
 * run the multi-turn blockpage flow even though client "assistant" history
 * is stripped for prompt-injection safety.
 *
 * Buddy's brain runs on Hedera's official `@hashgraph/hedera-agent-kit`:
 * the three chain tools are the kit's `Tool` objects from the Voicescape
 * read-only plugin (`@/lib/agent/agentkit`), executed through
 * `tool.execute` — not hand-rolled copies. All tools are TOOL_TYPE.QUERY
 * (asserted at request time by getBuddyTools()); no client/operator key
 * exists anywhere in this route, so the agent can never sign, spend, or
 * publish.
 *
 * Buddy also gets one creative tool, `generate_page_image`
 * (`@/lib/agent/image-tool`): it generates blockpage artwork and pins it
 * to IPFS. It is not a chain tool — it has no chain access, no client,
 * and no keys — so the "nothing here can sign/spend" invariant still
 * holds. Image abuse is bounded by a per-IP daily quota.
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
import { makeImageTool } from "@/lib/agent/image-tool";
import {
  agentChatClientIp,
  agentChatRateLimited,
} from "@/lib/agent/rate-limit";

export const runtime = "nodejs";

const MODEL = "openai/gpt-oss-20b";
const MAX_TOKENS = 2048;
const MAX_ITERATIONS = 8;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// The platform caps this function at 60s (see frontend/vercel.json), so our
// own abort must fire first — a clean 504 with a "timed out" reply beats a
// platform kill that surfaces as a generic network error.
const AGENT_TIMEOUT_MS = 55_000;

import {
  BUDDY_SYSTEM_PROMPT,
  sanitizeHistory,
  type ChatMessage,
} from "./guardrails";
import {
  advanceBuildState,
  buildStateNote,
  signBuildState,
  verifyBuildState,
} from "./build-state";
import {
  BUILD_FINALIZE_ERROR,
  BUILD_PAYWALL_ANON,
  BUILD_RACE_MESSAGE,
  BUILD_STORE_ERROR,
  CHAT_METER_ERROR,
  checkBuildAccess,
  checkChatAccess,
  consumeBuild,
  isOnTopicMessage,
  meteringBypass,
  noteChatMessage,
  type ChatIdentity,
} from "./metering";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { verifySessionToken } from "@/lib/server/townhall/auth";
import { extractPageDraft, stripPageDraft } from "@/lib/buddy-draft";

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling shape)
// ---------------------------------------------------------------------------



type ToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
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

async function callGroqOnce(
  apiKey: string,
  tools: Tool[],
  messages: ChatMessage[],
  signal: AbortSignal,
  // Server-tracked build progress (username/bio/vibe collected so far).
  // Lets the model run the multi-turn build flow even though client
  // "assistant" history is stripped for prompt-injection safety.
  buildNote: string | null
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
      messages: [
        { role: "system", content: BUDDY_SYSTEM_PROMPT },
        ...(buildNote ? [{ role: "system", content: buildNote }] : []),
        ...messages,
      ],
      tools: toFunctionDefs(tools),
    }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(
      `groq HTTP ${res.status} ${detail.slice(0, 200)}`
    ) as Error & { groqStatus?: number };
    err.groqStatus = res.status;
    throw err;
  }
  return res.json();
}

/**
 * One automatic retry on transient provider failures (429 / 5xx): the
 * first-attempt-fails-retry-succeeds pattern seen in production is almost
 * always a momentary Groq hiccup, and absorbing it here beats showing the
 * visitor an error bubble. Never retries our own abort or a client error
 * (4xx other than 429) — those would just fail the same way twice.
 */
async function callGroq(
  apiKey: string,
  tools: Tool[],
  messages: ChatMessage[],
  signal: AbortSignal,
  buildNote: string | null
): Promise<any> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      return await callGroqOnce(apiKey, tools, messages, signal, buildNote);
    } catch (e: any) {
      lastErr = e;
      const status = typeof e?.groqStatus === "number" ? e.groqStatus : 0;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (e?.name === "AbortError" || !retryable) throw e;
    }
  }
  throw lastErr;
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

  // Server-controlled build state: the widget echoes back the HMAC-signed
  // token from the previous turn; tampered tokens verify to null and the
  // turn falls back to no-state behavior. The state advances from the new
  // user message BEFORE the model runs, so the model always knows exactly
  // what is collected and what to ask next.
  const prevState = verifyBuildState(body?.build_state);
  const buildState = advanceBuildState(prevState, message);
  const buildNote = buildStateNote(buildState);

  // Build entitlement (5 HBAR per custom build, Brandon's pricing). The
  // state is complete when username + bio + vibe are all collected — that
  // is the turn the model generates the artwork and the draft JSON.
  const prevComplete = !!(prevState?.u && prevState?.b && prevState?.v);
  const buildComplete = !!(buildState.u && buildState.b && buildState.v);
  const justCompleted = buildComplete && !prevComplete;

  // The signed-in wallet (EVM address), or null for anonymous visitors.
  // Builds need a wallet — anonymous users are stopped at the paywall.
  // The wallet also identifies chat metering (anonymous chat is keyed by
  // IP and can never pay on-chain).
  let walletEvm: string | null = null;
  if (!meteringBypass()) {
    const cred = sessionCredentialFrom(req);
    const verified =
      typeof cred === "string" ? verifySessionToken(cred) : null;
    if (verified && verified.ok) walletEvm = verified.session.address;
  }
  const buildWallet = buildComplete ? walletEvm : null;

  if (justCompleted && !meteringBypass()) {
    // Fail fast BEFORE the model burns image generations on an unpaid
    // build. Anonymous visitors get the connect-wallet paywall; signed-in
    // wallets without a 5-HBAR build payment get the tip paywall.
    if (!buildWallet) {
      return NextResponse.json({
        reply: BUILD_PAYWALL_ANON,
        build_state: signBuildState(buildState),
      });
    }
    let access;
    try {
      access = await checkBuildAccess(buildWallet);
    } catch {
      console.error("[agent-chat] build store check failed");
      return NextResponse.json({
        reply: BUILD_STORE_ERROR,
        build_state: signBuildState(buildState),
      });
    }
    if (!access.allowed) {
      return NextResponse.json({
        reply: access.reason,
        build_state: signBuildState(buildState),
      });
    }
  }

  // Chat metering (Brandon's pricing, refined 2026-09-16): answering
  // Voicescape / blockchain questions is always free. Anything else costs
  // one message unit — 5 free per identity, then 5 HBAR per 50 messages.
  // The check runs BEFORE the model call so an unpaid turn burns nothing.
  // The turn that generates a build is covered by the build payment, so it
  // skips the chat check entirely. In-progress build answers are on-topic
  // by construction (they fill the username / bio / vibe slots).
  const inBuildFlow = buildState.active && !buildComplete;
  const onTopic = inBuildFlow || isOnTopicMessage(message);
  const chatIdentity: ChatIdentity =
    walletEvm != null
      ? { kind: "wallet", evm: walletEvm }
      : { kind: "anon", ip: agentChatClientIp(req) };
  let chatKind: "free" | "paid" | null = null;
  let chatLeft = 0;
  const chatMetered = !justCompleted && !onTopic && !meteringBypass();
  if (chatMetered) {
    let access;
    try {
      access = await checkChatAccess(chatIdentity);
    } catch {
      console.error("[agent-chat] chat meter check failed");
      return NextResponse.json(
        { error: "chat_meter_unavailable", reply: CHAT_METER_ERROR },
        { status: 503 }
      );
    }
    if (!access.allowed) {
      return NextResponse.json({
        reply: access.reason,
        build_state: signBuildState(buildState),
        chat: { metered: true, kind: "none", left: 0 },
      });
    }
    chatKind = access.kind;
    chatLeft = access.left;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  const signal = controller.signal;

  // Buddy's tools: Hedera's Agent Kit (read-only Voicescape plugin) plus the
  // image-generation tool (no chain access — artwork only).
  const tools = [...getBuddyTools(signal), makeImageTool(agentChatClientIp(req))];

  try {
    const messages: ChatMessage[] = [...history, { role: "user", content: message }];
    let finalContent: string | null = null;
    let truncated = false;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const data = await callGroq(apiKey, tools, messages, signal, buildNote);
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

    // Build consumption: the 5-HBAR payment is spent only when the reply
    // actually delivers a VALID page draft. A failed draft (no valid JSON)
    // never consumes — the user keeps their build credit. When the payment
    // can't be spent (lost a concurrent race, or the store is unreachable),
    // the draft is withheld instead of given away: the reply never carries
    // a draft the user wasn't charged for.
    if (buildComplete && !meteringBypass() && extractPageDraft(finalContent)) {
      if (!buildWallet) {
        const prose = stripPageDraft(finalContent);
        finalContent = prose ? `${prose}\n\n${BUILD_PAYWALL_ANON}` : BUILD_PAYWALL_ANON;
      } else {
        let spent = false;
        let finalizeFailed = false;
        try {
          spent = await consumeBuild(buildWallet);
        } catch {
          finalizeFailed = true;
        }
        if (!spent) {
          finalContent = finalizeFailed ? BUILD_FINALIZE_ERROR : BUILD_RACE_MESSAGE;
        }
      }
    }

    // Chat accounting: an off-topic turn that reached the model consumes
    // one message unit. The build-generation turn is covered by the build
    // payment. This runs after the reply exists — a store hiccup here must
    // not eat the reply the user is already owed (the pre-check above is
    // what fails closed).
    if (chatMetered && chatKind) {
      try {
        await noteChatMessage(chatIdentity, chatKind);
      } catch {
        // Served replies aren't revoked over an accounting hiccup.
      }
    }

    return NextResponse.json({
      reply: finalContent,
      // Opaque to the widget: the signed build state to echo back next turn.
      // "" when no secret is configured (state feature off).
      build_state: signBuildState(buildState),
      // Metering metadata for the widget (free-messages-left caption).
      chat: {
        metered: chatMetered,
        kind: chatMetered && chatKind ? chatKind : "none",
        left: Math.max(0, chatLeft - (chatMetered && chatKind ? 1 : 0)),
      },
    });
  } catch (e: any) {
    const aborted = signal.aborted;
    // Log the real cause (never the API key) so the next "Something went
    // wrong" is diagnosable from the server logs instead of a mystery.
    console.error(
      "[agent-chat]",
      aborted ? "timeout after 55s" : "request failed",
      e?.groqStatus ? `groq HTTP ${e.groqStatus}` : "",
      String(e?.message ?? e).slice(0, 500)
    );
    return NextResponse.json(
      { error: aborted ? "chat_timeout" : "chat_failed" },
      { status: aborted ? 504 : 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}
