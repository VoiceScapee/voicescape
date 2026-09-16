/**
 * Server-controlled build state for Buddy's 3-question blockpage flow.
 *
 * Why this exists: the chat route strips client-supplied "assistant"
 * messages (prompt-injection guardrail), so the model never sees its own
 * earlier questions. Without help it can't track a multi-turn flow — it
 * re-asks for the username forever (seen live 2026-09-16: user answered
 * "yes" to a confirmation and Buddy looped back to "pick a username").
 *
 * This module keeps the authoritative progress server-side, carried as an
 * HMAC-signed token (SESSION_SECRET — the same secret the session tokens
 * use). The widget echoes the token back each turn; the server verifies
 * the signature, advances the state from the new user message, and tells
 * the model exactly what is collected and what is still missing via a
 * system note. A forged or tampered token fails verification and the
 * turn falls back to no-state behavior — it can never inject text into
 * the model context.
 *
 * What the server tracks: username -> bio -> vibe/layout, in that order,
 * at most one slot filled per turn. Collection only starts after the
 * visitor shows build intent, so ordinary chat ("cool", "what's the
 * treasury?") never gets misread as a username.
 */
import { createHmac, timingSafeEqual } from "crypto";

export type BuildState = {
  /** true once the visitor has shown build intent */
  active: boolean;
  /** collected username (lowercase) */
  u?: string;
  /** collected bio */
  b?: string;
  /** collected vibe/layout */
  v?: string;
};

/** Same rule as lib/identity.ts isValidUsername — the on-chain charset. */
const USERNAME_RE = /^[a-z0-9-]{3,24}$/;
const BIO_MIN = 4;
const BIO_MAX = 280;
const VIBE_MIN = 3;
const VIBE_MAX = 200;

/** Phrases that start a build ("i want to build my own blockpage", …). */
const BUILD_INTENT_RE =
  /\b(build|blockpage|my page|create a page|make me a page|new page|start building)\b/i;
/** Phrases that restart a finished build ("build another one", …). */
const RESTART_RE =
  /\b(start over|another page|new page|second page|different page|build another)\b/i;
/** Don't mistake a mid-flow question for an answer ("what does it cost?"). */
const QUESTION_RE =
  /\?\s*$|^(what|how|why|when|where|who|which|is|are|can|could|do|does|should|will|would|tell me)\b/i;

function getSecret(): string {
  return (process.env.SESSION_SECRET ?? "").trim();
}

/**
 * Sign a build state into an opaque token for the widget to echo back.
 * Returns "" when no secret is configured — the state feature then stays
 * off and the chat behaves exactly as before (no-state fallback).
 */
export function signBuildState(state: BuildState): string {
  const secret = getSecret();
  if (!secret) return "";
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString(
    "base64url"
  );
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * Verify a widget-echoed token. Returns the state, or null when the
 * token is missing, malformed, tampered with, or signed with a different
 * secret. Never throws.
 */
export function verifyBuildState(token: unknown): BuildState | null {
  if (typeof token !== "string" || !token) return null;
  const secret = getSecret();
  if (!secret) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expected: string;
  try {
    expected = createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");
  } catch {
    return null;
  }
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return sanitizeState(parsed);
}

/** Re-validate every field — a valid signature alone isn't enough. */
function sanitizeState(raw: unknown): BuildState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: BuildState = { active: r.active === true };
  if (typeof r.u === "string" && USERNAME_RE.test(r.u)) out.u = r.u;
  if (
    typeof r.b === "string" &&
    r.b.length >= BIO_MIN &&
    r.b.length <= BIO_MAX
  )
    out.b = r.b;
  if (
    typeof r.v === "string" &&
    r.v.length >= VIBE_MIN &&
    r.v.length <= VIBE_MAX
  )
    out.v = r.v;
  return out;
}

/**
 * Advance the build state from one new user message. Fills at most the
 * first missing slot (username -> bio -> vibe). Pure and never throws —
 * when nothing matches, the state is returned unchanged and the model
 * handles the message conversationally.
 */
export function advanceBuildState(
  prev: BuildState | null,
  message: string
): BuildState {
  const msg = message.trim();
  if (!msg) return prev ?? { active: false };
  const state: BuildState = prev ?? { active: false };

  // A finished build plus "build another one" starts fresh.
  if (state.u && state.b && state.v && RESTART_RE.test(msg)) {
    return { active: true };
  }

  let s = state;
  if (!s.active) {
    if (!BUILD_INTENT_RE.test(msg)) return s;
    s = { ...s, active: true };
  }

  // Slot 1: username — the whole message must be a valid username, so
  // "call me X" or "what should I pick?" never misfires.
  if (!s.u && USERNAME_RE.test(msg.toLowerCase())) {
    return { ...s, u: msg.toLowerCase() };
  }
  // Slots 2-3: bio, then vibe — skip questions ("what does it cost?").
  if (s.u && !s.b && !QUESTION_RE.test(msg)) {
    if (msg.length >= BIO_MIN && msg.length <= BIO_MAX) {
      return { ...s, b: msg };
    }
    return s;
  }
  if (s.u && s.b && !s.v && !QUESTION_RE.test(msg)) {
    if (msg.length >= VIBE_MIN && msg.length <= VIBE_MAX) {
      return { ...s, v: msg };
    }
  }
  return s;
}

/**
 * The authoritative progress note injected into the model context.
 * Null when no build is in progress — the model just chats normally.
 */
export function buildStateNote(state: BuildState): string | null {
  if (!state.active) return null;
  const line = (label: string, v?: string) =>
    v ? `${label} (collected): "${v}"` : `${label}: MISSING`;
  const lines = [
    "[Build state — server-tracked and authoritative. The visitor is building their own blockpage.]",
    line("username", state.u),
    line("bio", state.b),
    line("vibe/layout", state.v),
  ];
  if (state.u && state.b && state.v) {
    lines.push(
      "All three are collected. Generate the artwork now (up to 3 images: avatar, banner, background) and output the complete JSON page. Do not ask any more questions."
    );
  } else {
    const missing = !state.u ? "username" : !state.b ? "bio" : "vibe/layout";
    lines.push(
      `Ask ONLY for the ${missing} next — one short question. NEVER re-ask for an item marked collected, and NEVER double-check a collected item ("are you sure?", "is X right?") — accept it and move on.`
    );
  }
  return lines.join("\n");
}
