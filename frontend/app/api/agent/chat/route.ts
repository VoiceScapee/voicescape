/**
 * POST /api/agent/chat — Voicescape onboarding buddy (read-only).
 *
 * Body: { message: string, history?: Array<{ role: "user"|"assistant", content: string }>,
 *          build_state?: string, refine_draft?: string, preview_draft?: string }
 * Response: { reply: string, build_state: string,
 *             build: { paywall: "anon" | "unpaid" | null,
 *                      preview: VoicescapePage | null,
 *                      previewsLeft: number | null } }
 *
 * refine_draft is the widget echoing the visitor's current page draft so a
 * follow-up message can revise it ("tweak" flow). It is validated against
 * the page schema and tied to the server-tracked build username — a tweak
 * never consumes a second payment, but a wallet with no build history can
 * never get a free build this way.
 *
 * preview_draft is the widget echoing the current FREE visual mock so a
 * follow-up can revise it (preview 2 of 2). Previews are pure model output
 * with placeholder art — the image tool is withheld on preview turns, so a
 * preview can never burn image generation.
 *
 * The `build.paywall` field is machine-readable UI signal for the widget:
 * "anon" = builds need a connected wallet, "unpaid" = the signed-in wallet
 * has no 5-HBAR build credit yet, null = no paywall on this turn.
 * `build.preview` carries the free visual mock (rendered by the widget with
 * BuddyDraftPreview — never the "Open in Builder"/"Publish" path, which is
 * reserved for the paid build). `build.previewsLeft` is the remaining free
 * previews for this build (null when previews don't apply this turn).
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
// Image generation can take up to a minute; the chat loop stays well under this.
const AGENT_TIMEOUT_MS = 120_000;

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
  BUILD_PAYWALL_UNPAID,
  BUILD_RACE_MESSAGE,
  BUILD_STORE_ERROR,
  CHAT_METER_ERROR,
  MAX_FREE_PREVIEWS,
  checkBuildAccess,
  checkChatAccess,
  consumeBuild,
  getLastMock,
  getPreviewsUsed,
  hasBuildHistory,
  isOnTopicMessage,
  meteringBypass,
  noteChatMessage,
  notePreview,
  saveLastMock,
  type ChatIdentity,
} from "./metering";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { verifySessionToken } from "@/lib/server/townhall/auth";
import { extractPageDraft, stripPageDraft } from "@/lib/buddy-draft";
import { isValidPage, type VoicescapePage } from "@/lib/schema";

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

async function callGroq(
  apiKey: string,
  tools: Tool[],
  messages: ChatMessage[],
  signal: AbortSignal,
  // Server-tracked build progress (username/bio/vibe collected so far).
  // Lets the model run the multi-turn build flow even though client
  // "assistant" history is stripped for prompt-injection safety.
  buildNote: string | null,
  // Extra server-authored system notes (e.g. draft-revision context).
  extraNotes: string[] = []
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
        ...extraNotes.map((content) => ({ role: "system", content })),
        ...messages,
      ],
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
// Draft refinement ("tweak") helpers
// ---------------------------------------------------------------------------

/** Cap on the echoed draft — pages are small; anything bigger is rejected. */
const MAX_REFINE_BYTES = 20_480;

/**
 * Validate a widget-echoed draft for the tweak flow. Returns the page when
 * it parses and validates against the page schema, else null. Never throws.
 */
function parseRefineDraft(raw: unknown): VoicescapePage | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_REFINE_BYTES) {
    return null;
  }
  try {
    const data: unknown = JSON.parse(raw);
    return isValidPage(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Validate a widget-echoed FREE mock for the preview-revision flow. Same
 * shape rules as refine drafts, plus the username must match the
 * server-tracked build username — a mock for another build can't be
 * smuggled in. Never throws.
 */
function parsePreviewDraft(
  raw: unknown,
  username: string | undefined
): VoicescapePage | null {
  const page = parseRefineDraft(raw);
  if (!page || !username) return null;
  return page.username.toLowerCase() === username ? page : null;
}

/**
 * Whole-message approval of the mock ("go", "looks good", "build it").
 * Anchored: "looks good but make it darker" is a revision, not approval.
 * An approval skips any remaining free previews and goes to the paywall
 * (or straight to the paid build when credit already exists).
 */
const PREVIEW_APPROVAL_RE =
  /^(go|yes|yeah|yep|yup|sure|ok|okay|do it|build it|looks good|great|perfect|awesome|amazing|ship it|let'?s (do it|go|build)|proceed|approved?|i'?m ready|pay)\b[.!?\s]*$/i;

/**
 * System note for a free visual-mock preview turn. Overrides the build
 * note's "generate the artwork" instruction: the visitor has NOT paid, so
 * this is a MOCK with placeholder art only — never real image generation.
 * Production-grade means the full block vocabulary and a real theme, not
 * a bare stub. The envelope is spelled out exactly because a mock missing
 * it fails validation and the visitor would see raw JSON.
 */
const PREVIEW_NOTE = [
  "[MOCK PREVIEW — this overrides the 'generate the artwork' instruction in the build note above. The visitor has NOT paid yet: this is a FREE preview, not the build.]",
  "Output the page as ONE complete ```json fenced block. It MUST be valid JSON matching this exact envelope — no comments, no trailing commas:",
  '{ "version": 1, "username": "<the exact collected username, lowercase>", "theme": { "background": "<css color>", "foreground": "<css color>", "accent": "<css color>", "fontFamily": "<css font stack>" }, "blocks": [ ... ] }',
  "Every block needs a valid type: hero, bio, links, tipJar, guestbook, music, gallery, top8, services, capabilities, operator, reviews, booking, livestream, chat.",
  "CONTENT RULES — realistic and specific to THEIR username/bio/vibe, never placeholder junk:",
  "- hero: title is a display name from the username, subtitle a tagline from their bio/vibe, avatarEmoji one fitting emoji (NEVER avatarImage).",
  "- bio: expand their one-liner into 1-2 vivid sentences.",
  "- links: 3-5 links with realistic labels and plausible https URLs (e.g. https://x.com/<username>). Never 'Link 1', never 'Item N', never example.com.",
  "- top8: friends with realistic names/handles and a fitting avatarEmoji each. Never 'Item 1'.",
  "- gallery: emoji images ONLY (e.g. [\"🎨\",\"📸\",\"✨\"]) with an effect (float, marquee, or dance). Never URLs.",
  "- music: include ONLY if the visitor named a specific artist/song — never invent track IDs.",
  "- tipJar: one warm thank-you line.",
  "- 6-9 blocks total. Theme colors and font must match the vibe exactly.",
  "PLACEHOLDER ART ONLY: never URLs, never IPFS, never call generate_page_image — the tool is unavailable this turn.",
  "Keep your visible reply to one or two short sentences: present the mock, invite one tweak, and say that saying \"go\" builds the real page with custom AI artwork for 5 HBAR.",
].join("\n");

/** System note for revising the free mock (preview 2 of 2). */
function previewReviseNote(mock: VoicescapePage): string {
  return [
    "[MOCK PREVIEW REVISION — the visitor is revising their FREE preview. They have NOT paid.]",
    "Current mock JSON:",
    JSON.stringify(mock).slice(0, MAX_REFINE_BYTES),
    "Revise ONLY what they asked for; keep everything else identical. Still placeholder art only (emoji, never URLs/IPFS) — do NOT call generate_page_image: the tool is unavailable this turn. " +
      "Keep every visible label realistic — never placeholder text like \"Item 1\". " +
      "Output the FULL revised page as a single ```json fenced block matching the page schema envelope from the preview instructions. " +
      'Keep your visible reply to one short sentence, ending with: say "go" any time and the 5 HBAR build makes the real page.',
  ].join("\n");
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

  // Draft refinement ("tweak"): the widget echoes the visitor's current
  // draft so a follow-up message revises it. The draft must validate AND
  // its username must match the server-tracked build username — this ties
  // the tweak to the paid build lineage, so a fabricated draft can never
  // buy a free build. Refinement only applies once the build is complete
  // (mid-flow drafts don't exist yet).
  const refineDraft = parseRefineDraft(body?.refine_draft);
  const isRefineTurn =
    buildComplete &&
    refineDraft != null &&
    buildState.u != null &&
    refineDraft.username.toLowerCase() === buildState.u;
  const refineNote = isRefineTurn
    ? [
        "[Draft revision — the visitor already paid for this build and has a complete page draft. They asked for a tweak.]",
        "Current draft JSON:",
        JSON.stringify(refineDraft).slice(0, MAX_REFINE_BYTES),
        "Revise ONLY what they asked for; keep everything else identical, including all image URLs. " +
          "Do NOT regenerate images unless they explicitly ask for visual/artwork changes. " +
          "Output the FULL revised page as a single ```json fenced block matching the page schema. " +
          "Keep your visible reply to one short sentence.",
      ].join("\n")
    : null;

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

  // Free visual-mock previews (Brandon's 2026-09-16 spec): once the three
  // slots are collected, the visitor gets up to 2 free visual mocks BEFORE
  // any paywall. Mocks are pure model output with placeholder art — the
  // image tool is withheld on preview turns (see tools below), so a
  // preview can never burn image generation. After the 2nd mock, or on an
  // explicit "go", the paywall appears; 5 HBAR then unlocks ONE full
  // production-grade build with real AI artwork.
  //
  // Preview identity follows the chat-metering pattern: the signed-in
  // wallet when present, else the IP. Counted per build username and reset
  // when a build payment is consumed, so a brand-new build repeats the
  // whole process (2 free previews -> 5 HBAR -> build).
  const previewIdentity: ChatIdentity =
    walletEvm != null
      ? { kind: "wallet", evm: walletEvm }
      : { kind: "anon", ip: agentChatClientIp(req) };
  const previewDraftEcho = parsePreviewDraft(body?.preview_draft, buildState.u);
  const isApproval = PREVIEW_APPROVAL_RE.test(message);
  const isPreviewRevisionTurn =
    buildComplete && !justCompleted && !isApproval && previewDraftEcho != null;
  // Fallback: the visitor typed a tweak as plain text (no preview_draft
  // echo — they never tapped "Tweak this preview"). When the build is
  // complete, this isn't an approval or a paid tweak, treat it as a
  // mock-tweak turn instead of falling through to the paywall. Whether it
  // actually becomes a preview is decided in the entitlement branch below:
  // wallets that already hold build credit get the paid build, never a
  // free mock, and exhausted previews still paywall.
  const isPreviewTweakFallbackCandidate =
    buildComplete &&
    !justCompleted &&
    !isApproval &&
    !isRefineTurn &&
    previewDraftEcho == null;

  let previewMode: "new" | "revise" | null = null;
  let previewsUsed = 0;
  // Decided pre-model on paywalled turns, post-model on preview turns
  // (the 2nd mock ships with the paywall panel); null otherwise.
  let paywallKind: "anon" | "unpaid" | null = null;

  if (!meteringBypass() && buildComplete) {
    try {
      previewsUsed = await getPreviewsUsed(
        previewIdentity,
        buildState.u ?? ""
      );
    } catch {
      return NextResponse.json(
        { error: "preview_meter_unavailable", reply: BUILD_STORE_ERROR },
        { status: 503 }
      );
    }
    const previewsLeftNow = Math.max(0, MAX_FREE_PREVIEWS - previewsUsed);
    if (justCompleted && previewsLeftNow > 0) {
      previewMode = "new";
    } else if (isPreviewRevisionTurn && previewsLeftNow > 0) {
      previewMode = "revise";
    } else if (!isRefineTurn) {
      // No free previews left (or the visitor approved the mock) and this
      // isn't a paid tweak: the model would generate the build now. Never
      // burn image generations without a payment — check entitlement
      // BEFORE the model runs.
      //
      // Plain-text tweak fallback: the visitor typed a tweak as plain text
      // (no preview_draft echo — they never tapped "Tweak this preview").
      // Only free while the build is unpaid: a wallet that holds or ever
      // spent build credit gets the real build or the paywall, never
      // another free mock.
      const fallbackTweak =
        isPreviewTweakFallbackCandidate && previewsLeftNow > 0;
      if (!buildWallet) {
        if (fallbackTweak) {
          // Anonymous visitor still in the preview flow: "revise" when a
          // mock was already served, else a fresh first mock.
          previewMode = previewsUsed > 0 ? "revise" : "new";
        } else {
          return NextResponse.json({
            reply: BUILD_PAYWALL_ANON,
            build_state: signBuildState(buildState),
            build: { paywall: "anon", preview: null, previewsLeft: previewsLeftNow },
          });
        }
      } else {
        let access;
        try {
          access = await checkBuildAccess(buildWallet);
        } catch {
          return NextResponse.json({
            reply: BUILD_STORE_ERROR,
            build_state: signBuildState(buildState),
            build: { paywall: null, preview: null, previewsLeft: previewsLeftNow },
          });
        }
        let freeFallback = false;
        if (fallbackTweak && !access.allowed) {
          try {
            freeFallback = !(await hasBuildHistory(buildWallet));
          } catch {
            return NextResponse.json({
              reply: BUILD_STORE_ERROR,
              build_state: signBuildState(buildState),
              build: { paywall: null, preview: null, previewsLeft: previewsLeftNow },
            });
          }
        }
        if (freeFallback) {
          previewMode = previewsUsed > 0 ? "revise" : "new";
        } else if (!access.allowed) {
          return NextResponse.json({
            reply: access.reason,
            build_state: signBuildState(buildState),
            build: { paywall: "unpaid", preview: null, previewsLeft: previewsLeftNow },
          });
        }
        // Paid (access.allowed): fall through — the model runs WITH the
        // image tool and the post-model block consumes the payment on a
        // valid draft.
      }
    }
  }

  // Fallback revision context: the widget didn't echo the mock, so load
  // the last served mock server-side. Without one there is nothing to
  // revise — generate a fresh mock instead of a context-free "revision".
  let fallbackMock: VoicescapePage | null = null;
  if (previewMode === "revise" && !previewDraftEcho && !meteringBypass()) {
    try {
      fallbackMock = await getLastMock(previewIdentity, buildState.u ?? "");
    } catch {
      fallbackMock = null;
    }
    if (!fallbackMock) previewMode = "new";
  }

  // Refine turns ride on the ORIGINAL build payment: the wallet must have
  // build history (it paid for a build before). No history → unpaid
  // paywall before the model runs, so a fabricated refine draft can never
  // buy a free build (and never costs us a model call).
  if (isRefineTurn && !meteringBypass() && buildWallet) {
    let history = false;
    try {
      history = await hasBuildHistory(buildWallet);
    } catch {
      history = false;
    }
    if (!history) {
      return NextResponse.json({
        reply: BUILD_PAYWALL_UNPAID,
        build_state: signBuildState(buildState),
        build: { paywall: "unpaid" },
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
  // Build revisions are product questions (same as the page-editing
  // vocabulary in isOnTopicMessage) — tweaks never eat free chat messages.
  // Free-mock turns (previewMode, decided above) are on-topic by
  // construction for the same reason.
  const onTopic =
    inBuildFlow ||
    isRefineTurn ||
    isPreviewRevisionTurn ||
    previewMode !== null ||
    isOnTopicMessage(message);
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
  // ECONOMICS INVARIANT: preview turns NEVER get the image tool — a free
  // mock is pure model output with placeholder art, so even a misbehaving
  // model can't burn image generation before payment.
  const tools = previewMode
    ? getBuddyTools(signal)
    : [...getBuddyTools(signal), makeImageTool(agentChatClientIp(req))];

  try {
    const messages: ChatMessage[] = [...history, { role: "user", content: message }];
    let finalContent: string | null = null;
    let truncated = false;

    // Free-mock instruction (overrides the build note's "generate the
    // artwork" line): the model outputs a placeholder-art mock, never
    // real images. On a fallback revision (no widget echo) the mock comes
    // from the server-side last-mock store.
    const reviseMock = previewDraftEcho ?? fallbackMock;
    const previewNote =
      previewMode === "new"
        ? PREVIEW_NOTE
        : previewMode === "revise" && reviseMock
          ? previewReviseNote(reviseMock)
          : previewMode === "revise"
            ? PREVIEW_NOTE // unreachable: demoted to "new" above; safety
            : null;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const data = await callGroq(
        apiKey,
        tools,
        messages,
        signal,
        buildNote,
        [...(refineNote ? [refineNote] : []), ...(previewNote ? [previewNote] : [])]
      );
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
    //
    // Tweaks (refine turns) ride on the original build payment: the wallet
    // must have build history (it paid for a build before), but no second
    // payment is consumed. A wallet with no build history gets the unpaid
    // paywall instead of a free draft.
    // Free-mock delivery: pull the mock out of the reply prose (the widget
    // renders it from build.preview — never as a paid draft), count it
    // against the free allowance, remember it for plain-text follow-up
    // tweaks, and attach the 2nd mock's paywall so the visitor can pay
    // without another round trip. A model glitch that produced no valid
    // mock never consumes the allowance — and raw JSON/fences are stripped
    // from the visible reply regardless, so the visitor never sees them.
    let previewPage: VoicescapePage | null = null;
    let previewsLeftOut: number | null = null;
    if (previewMode && !meteringBypass()) {
      const mock = extractPageDraft(finalContent);
      previewsLeftOut = Math.max(0, MAX_FREE_PREVIEWS - previewsUsed);
      if (mock) {
        previewPage = mock;
        const prose = stripPageDraft(finalContent);
        finalContent =
          prose ||
          "Here's a mock of your page — tell me what to tweak, or say “go” and I'll build the real thing.";
        try {
          previewsUsed = await notePreview(previewIdentity, buildState.u ?? "");
          await saveLastMock(previewIdentity, buildState.u ?? "", mock);
        } catch {
          // Served mocks aren't revoked over an accounting hiccup (same
          // precedent as chat accounting below); the pre-model check above
          // is what fails closed.
        }
        previewsLeftOut = Math.max(0, MAX_FREE_PREVIEWS - previewsUsed);
      } else {
        finalContent = stripPageDraft(finalContent);
        if (!finalContent) {
          finalContent =
            "I couldn't sketch that mock — tell me to try again and I'll have another go.";
        }
      }
      if (previewsLeftOut === 0) {
        if (!buildWallet) {
          paywallKind = "anon";
        } else {
          try {
            const access = await checkBuildAccess(buildWallet);
            paywallKind = access.allowed ? null : "unpaid";
          } catch {
            // Mirror hiccup: no panel this turn — the visitor can still say
            // "go" and the paid-build gate checks entitlement again.
            paywallKind = null;
          }
        }
      }
    }

    if (buildComplete && !meteringBypass() && !previewMode && extractPageDraft(finalContent)) {
      if (!buildWallet) {
        const prose = stripPageDraft(finalContent);
        finalContent = prose ? `${prose}\n\n${BUILD_PAYWALL_ANON}` : BUILD_PAYWALL_ANON;
        paywallKind = "anon";
      } else if (isRefineTurn) {
        let history = false;
        try {
          history = await hasBuildHistory(buildWallet);
        } catch {
          history = false;
        }
        if (!history) {
          finalContent = BUILD_PAYWALL_UNPAID;
          paywallKind = "unpaid";
        }
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
      // Machine-readable build signal for the widget (paywall UI + free
      // visual-mock preview).
      build: {
        paywall: paywallKind,
        preview: previewPage,
        previewsLeft: previewsLeftOut,
      },
      // Metering metadata for the widget (free-messages-left caption).
      chat: {
        metered: chatMetered,
        kind: chatMetered && chatKind ? chatKind : "none",
        left: Math.max(0, chatLeft - (chatMetered && chatKind ? 1 : 0)),
      },
    });
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
