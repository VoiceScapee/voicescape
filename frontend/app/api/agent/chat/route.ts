/**
 * POST /api/agent/chat — Voicescape onboarding buddy (read-only).
 *
 * Body: { message: string, history?: Array<{ role: "user"|"assistant", content: string }>,
 *          build_state?: string, refine_draft?: string, preview_draft?: string }
 * Response: { reply: string, build_state: string,
 *             build: { paywall: "anon" | "unpaid" | null,
 *                      preview: VoicescapePage | null,
 *                      previewsLeft: number | null,
 *                      previewSource: "template" | "template-tweak" | null } }
 *
 * refine_draft is the widget echoing the visitor's current page draft so a
 * follow-up message can revise it ("tweak" flow). It is validated against
 * the page schema and tied to the server-tracked build username — a tweak
 * never consumes a second payment, but a wallet with no build history can
 * never get a free build this way.
 *
 * preview_draft is the widget echoing the current FREE visual mock so a
 * follow-up can revise it (preview 2 of 2). Previews are DETERMINISTIC
 * server-built mocks (templatePreviewPage / applyPreviewTweak) with
 * placeholder art — the model writes conversational text only and the
 * image tool is withheld on preview turns, so a preview can never burn
 * image generation and a garbled model reply can never break the mock.
 *
 * The `build.paywall` field is machine-readable UI signal for the widget:
 * "anon" = builds need a connected wallet, "unpaid" = the signed-in wallet
 * has no 5-HBAR build credit yet, null = no paywall on this turn.
 * `build.preview` carries the free visual mock (rendered by the widget with
 * BuddyDraftPreview — never the "Open in Builder"/"Publish" path, which is
 * reserved for the paid build). `build.previewsLeft` is the remaining free
 * previews for this build (null when previews don't apply this turn).
 * `build.previewSource` ("template" for mock #1, "template-tweak" for mock
 * #2, null otherwise) is not user-visible — it tells live debugging which
 * path served the mock.
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
// Preview turns emit a full 6-9 block page JSON plus prose — 2048 tokens
// truncated the mock mid-string live (2026-09-16), leaking raw JSON.
const PREVIEW_MAX_TOKENS = 4096;
const MAX_ITERATIONS = 8;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// The platform caps this function at 60s (see frontend/vercel.json), so our
// own abort must fire first — a clean 504 with a "timed out" reply beats a
// platform kill that surfaces as a generic network error.
const AGENT_TIMEOUT_MS = 55_000;

// Graceful degradation when the free Groq plan's daily token quota is spent:
// Buddy tells the visitor he's resting instead of an error bubble. Retrying
// is futile until the quota resets, so the widget gets a normal HTTP 200
// reply (no tap-to-retry). No chat unit is consumed on this path — the
// accounting lives in the try block and is skipped when the model throws.
const QUOTA_EXHAUSTED_REPLY =
  "My AI brain just hit its daily limit — I'm on the free plan, so I get a fresh batch of thinking tokens every day. Try me again tomorrow and I'll be back to full strength!";

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
import { signJobStartToken } from "./build-job/job";
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
import {
  applyPreviewTweak,
  isValidPage,
  normalizeBlockForRender,
  templatePreviewPage,
  type VoicescapePage,
} from "@/lib/schema";

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
  buildNote: string | null,
  // Extra server-authored system notes (e.g. draft-revision context).
  extraNotes: string[] = [],
  // Preview turns emit a full page JSON — give them a bigger token budget
  // so the mock isn't cut off mid-string (truncated JSON can never parse
  // and used to leak raw into the visible reply).
  maxTokens: number = MAX_TOKENS
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
      max_tokens: maxTokens,
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
    const err = new Error(
      `groq HTTP ${res.status} ${detail.slice(0, 200)}`
    ) as Error & { groqStatus?: number; groqQuotaExhausted?: boolean };
    err.groqStatus = res.status;
    // A 429 for tokens-per-day means the free plan's daily quota is spent:
    // retrying can never succeed until it resets, so mark it for the
    // caller to degrade gracefully instead of retrying.
    err.groqQuotaExhausted =
      res.status === 429 && /tokens per day|\(TPD\)/i.test(detail);
    throw err;
  }
  return res.json();
}

/**
 * One automatic retry on transient provider failures (429 / 5xx): the
 * first-attempt-fails-retry-succeeds pattern seen in production is almost
 * always a momentary Groq hiccup, and absorbing it here beats showing the
 * visitor an error bubble. Never retries our own abort, a client error
 * (4xx other than 429) — those would just fail the same way twice — or a
 * 429 that means the daily token quota is exhausted, which cannot clear
 * until the quota resets.
 */
async function callGroq(
  apiKey: string,
  tools: Tool[],
  messages: ChatMessage[],
  signal: AbortSignal,
  buildNote: string | null,
  extraNotes: string[] = [],
  maxTokens: number = MAX_TOKENS
): Promise<any> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      return await callGroqOnce(
        apiKey,
        tools,
        messages,
        signal,
        buildNote,
        extraNotes,
        maxTokens
      );
    } catch (e: any) {
      lastErr = e;
      // Daily-quota 429: fail fast so the route degrades gracefully instead
      // of burning a second request that cannot succeed.
      if (e?.groqQuotaExhausted) throw e;
      const status = typeof e?.groqStatus === "number" ? e.groqStatus : 0;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (e?.name === "AbortError" || !retryable) throw e;
    }
  }
  throw lastErr;
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
 * System note for a free visual-mock preview turn. ROUND 4 (2026-09-16):
 * the visual mock is built DETERMINISTICALLY server-side from the
 * collected username/bio/vibe — the model writes conversational text
 * ONLY and must not output any JSON. (Three live rounds proved model
 * JSON unreliable: truncation, wrong-typed scalars, and a provider-less
 * render crash. The template always renders.)
 */
const PREVIEW_NOTE = [
  "[MOCK PREVIEW — the visitor has NOT paid yet: this is a FREE preview, not the build.]",
  "A visual mock of their page is generated for them automatically — you do NOT need to output any JSON, code blocks, or a text description of the page.",
  "Reply in one or two short sentences: present their free preview, invite one tweak, and say that saying “go” builds the real page with custom AI artwork for 5 HBAR.",
  "PLACEHOLDER ART ONLY: never call generate_page_image — the image tool is unavailable this turn.",
].join("\n");

/** System note for revising the free mock (preview 2 of 2). The revised
 *  mock is applied deterministically server-side from the visitor's tweak
 *  text — the model writes conversational text only, never JSON. */
function previewReviseNote(tweak: string): string {
  return [
    "[MOCK PREVIEW REVISION — the visitor is revising their FREE preview. They have NOT paid.]",
    `The visitor's tweak request: "${tweak.slice(0, 300)}"`,
    "Their preview updates automatically — you do NOT need to output any JSON, code blocks, or a text description of the page.",
    "Reply in one short sentence acknowledging the tweak, ending with: say “go” any time and the 5 HBAR build makes the real page.",
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
  // Computed AFTER previewMode is finalized below (the all-collected note
  // differs on free-mock turns — see buildStateNote). Declared here so the
  // whole handler can reference it.
  let buildNote: string | null = null;

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
      console.error("[agent-chat] build store check failed");
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
            build: { paywall: "anon", preview: null, previewsLeft: previewsLeftNow, previewSource: null },
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
            build: { paywall: null, preview: null, previewsLeft: previewsLeftNow, previewSource: null },
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
              build: { paywall: null, preview: null, previewsLeft: previewsLeftNow, previewSource: null },
            });
          }
        }
        if (freeFallback) {
          previewMode = previewsUsed > 0 ? "revise" : "new";
        } else if (!access.allowed) {
          return NextResponse.json({
            reply: access.reason,
            build_state: signBuildState(buildState),
            build: { paywall: "unpaid", preview: null, previewsLeft: previewsLeftNow, previewSource: null },
          });
        }
        // Paid (access.allowed): the visitor approved the mock ("go").
        // Hand the widget a signed async job-start token INSTEAD of
        // generating synchronously — the full paid build (copy + AI
        // artwork + pin) exceeds the ~60s serverless execution window, so
        // the widget drives start -> poll -> deliver via
        // /api/agent/chat/build-job. This turn returns immediately.
        // Non-approval messages keep the existing model-driven paid path.
        if (isApproval && buildState.u && buildState.b && buildState.v) {
          const jobToken = signJobStartToken({
            wallet: buildWallet.toLowerCase(),
            u: buildState.u,
            b: buildState.b,
            v: buildState.v,
          });
          if (jobToken) {
            return NextResponse.json({
              reply:
                "On it — building your real page now. I'll draft the layout, paint custom AI artwork, and finalize. This takes about a minute; hang tight.",
              build_state: signBuildState(buildState),
              build: {
                paywall: null,
                preview: null,
                previewsLeft: previewsLeftNow,
                previewSource: null,
                buildJob: { token: jobToken },
              },
            });
          }
          // No signing secret: fall through to the legacy sync path.
        }
        // Paid (access.allowed), non-approval: fall through — the model runs
        // WITH the image tool and the post-model block consumes the payment
        // on a valid draft.
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

  // The authoritative build-progress note, now that previewMode is final:
  // on free-mock turns it defers to the preview instructions instead of
  // contradicting them with the paid-build directive.
  buildNote = buildStateNote(buildState, previewMode);

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

    // Free-mock instruction: the model writes conversational text only —
    // the visual mock itself is built deterministically server-side.
    const previewNote =
      previewMode === "new"
        ? PREVIEW_NOTE
        : previewMode === "revise"
          ? previewReviseNote(message)
          : null;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const data = await callGroq(
        apiKey,
        tools,
        messages,
        signal,
        buildNote,
        [...(refineNote ? [refineNote] : []), ...(previewNote ? [previewNote] : [])],
        previewMode ? PREVIEW_MAX_TOKENS : MAX_TOKENS
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
    // Free-mock delivery (ROUND 4): the visual mock is built
    // DETERMINISTICALLY server-side — never from model JSON. The model
    // writes conversational text only. This is what finally killed the
    // live failures: truncated JSON, wrong-typed scalars, and the
    // provider-less render crash are all impossible when the mock never
    // depends on model output. The widget renders it from build.preview
    // (never as a paid draft); serving it consumes one free-preview
    // allowance; it's remembered for follow-up tweaks; and the 2nd mock
    // ships with the paywall so the visitor can pay without another round
    // trip. previewSource tells live debugging which path served the mock.
    let previewPage: VoicescapePage | null = null;
    let previewsLeftOut: number | null = null;
    let previewSource: "template" | "template-tweak" | null = null;
    if (previewMode && !meteringBypass()) {
      if (previewMode === "revise") {
        // Mock #2: apply the visitor's tweak to the served mock (widget
        // echo preferred, server-stored last mock as fallback, fresh
        // template when neither exists). Always visibly different, always
        // valid, always renders.
        const base =
          previewDraftEcho ??
          fallbackMock ??
          templatePreviewPage(
            buildState.u ?? "you",
            buildState.b ?? "",
            buildState.v ?? ""
          );
        const tweaked = applyPreviewTweak(base, message);
        previewPage = tweaked.page;
        previewSource = "template-tweak";
        const prose = stripPageDraft(finalContent);
        finalContent = `${prose || "Done — here's the updated mock."} ${tweaked.note}`;
      } else {
        previewPage = templatePreviewPage(
          buildState.u ?? "you",
          buildState.b ?? "",
          buildState.v ?? ""
        );
        previewSource = "template";
        const prose = stripPageDraft(finalContent);
        finalContent =
          prose ||
          "Here's a mock of your page — tell me what to tweak, or say “go” and I'll build the real thing.";
      }
      // Render-safety belt-and-suspenders: normalize every block before it
      // ever reaches the client (the template is already clean; this costs
      // nothing and keeps the invariant that build.preview is always
      // renderer-safe).
      previewPage = {
        ...previewPage,
        blocks: previewPage.blocks
          .map(normalizeBlockForRender)
          .filter((b): b is NonNullable<ReturnType<typeof normalizeBlockForRender>> => b !== null),
      };
      try {
        previewsUsed = await notePreview(previewIdentity, buildState.u ?? "");
        await saveLastMock(previewIdentity, buildState.u ?? "", previewPage);
      } catch {
        // Served mocks aren't revoked over an accounting hiccup (same
        // precedent as chat accounting below); the pre-model check above
        // is what fails closed.
      }
      previewsLeftOut = Math.max(0, MAX_FREE_PREVIEWS - previewsUsed);
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
      // visual-mock preview). previewSource ("template" | "template-tweak"
      // | null) is not user-visible — it tells live debugging which path
      // served the mock.
      build: {
        paywall: paywallKind,
        preview: previewPage,
        previewsLeft: previewsLeftOut,
        previewSource,
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
    // Log the real cause (never the API key) so the next "Something went
    // wrong" is diagnosable from the server logs instead of a mystery.
    console.error(
      "[agent-chat]",
      aborted ? "timeout after 55s" : "request failed",
      e?.groqStatus ? `groq HTTP ${e.groqStatus}` : "",
      String(e?.message ?? e).slice(0, 500)
    );
    // Daily token quota exhausted: degrade gracefully. Buddy tells the
    // visitor he's resting (HTTP 200 with a normal reply — no error bubble,
    // no tap-to-retry, since retrying is futile until the quota resets).
    // The signed build state is still returned so a build in progress can
    // resume tomorrow; no chat unit is consumed on this path.
    if (!aborted && e?.groqQuotaExhausted) {
      return NextResponse.json({
        reply: QUOTA_EXHAUSTED_REPLY,
        build_state: signBuildState(buildState),
        chat: {
          metered: chatMetered,
          kind: chatMetered && chatKind ? chatKind : "none",
          left: Math.max(0, chatLeft),
        },
      });
    }
    return NextResponse.json(
      { error: aborted ? "chat_timeout" : "chat_failed" },
      { status: aborted ? 504 : 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}
