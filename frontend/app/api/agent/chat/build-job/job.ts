/**
 * Async paid-build jobs for Blockpage Buddy.
 *
 * Why this exists: the paid build (LLM page generation + up to 3 AI
 * artworks + IPFS pin) takes ~90s, but Vercel serverless invocations are
 * killed at ~60s. The synchronous chat route therefore can never deliver
 * a paid build — the turn times out and (correctly) consumes nothing.
 *
 * The async flow splits the build into short steps the widget drives:
 *
 *   chat "go" turn  ->  POST build-job {action:"start", token}
 *                    ->  POST build-job {action:"step", jobId}  (poll)
 *                    ->  {done:true, draft}  (production-grade page)
 *
 * Steps, each bounded to ~45s so no invocation nears the platform limit:
 *   copy     — one LLM call writes the full page JSON with artwork
 *              markers (no image tool, so it stays fast)
 *   images   — one AI artwork per call (the slow part, isolated)
 *   finalize — the draft is validated, then the 5-HBAR payment is consumed
 *              exactly once via the atomic spend claim in metering.ts
 *
 * Money rules (same as the sync path):
 * - The payment is consumed ONLY in finalize, and only after the draft
 *   validates. A failed draft never consumes — the visitor keeps credit.
 * - consumeBuild's atomic spend claim makes consumption exactly-once even
 *   if two jobs race for the same payment; the loser fails cleanly.
 * - start is idempotent per (wallet, username): an in-flight job is
 *   resumed, never duplicated.
 * - A step that times out leaves the job active — the widget retries the
 *   same step. Image slots are filled deterministically from the draft,
 *   so a retried images-step never generates the same artwork twice.
 *
 * The job-start token is HMAC-signed (SESSION_SECRET, like build_state):
 * it binds the wallet + collected username/bio/vibe and expires in
 * 10 minutes, so a job can't be forged for someone else's build.
 *
 * $0 rule: no new infrastructure — jobs live in the shared KvStore
 * (whatever backend is configured), the model is the existing Groq key,
 * artwork is the existing Pollinations + Pinata image tool.
 */
import { createHmac, randomUUID, timingSafeEqual } from "crypto";

import { getKvStore, type KvStore } from "@/lib/server/store";
import { extractPageDraft } from "@/lib/buddy-draft";
import { isValidPage, type VoicescapePage } from "@/lib/schema";
import { makeImageTool } from "@/lib/agent/image-tool";
import {
  BUILD_RACE_MESSAGE,
  checkBuildAccess,
  consumeBuild,
} from "../metering";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-20b";
const COPY_MAX_TOKENS = 4096;
/** Per-step wall clock budget — comfortably under the ~60s platform limit. */
const STEP_BUDGET_MS = 45_000;
/** Jobs live long enough for a few minutes of widget polling. */
const JOB_TTL_MS = 30 * 60 * 1000;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_ARTWORK = 3;
/** Image attempts per artwork slot before the job fails (credit preserved). */
const MAX_IMAGE_ATTEMPTS = 3;
/**
 * Slow-generation retries per artwork slot before the job fails (credit
 * preserved). A step-budget abort means Pollinations was still painting when
 * the 45s serverless budget ran out — a cold/slow art service, not a broken
 * build — so it retries on a separate, more patient counter instead of
 * burning one of the 3 hard-error strikes above.
 */
const MAX_IMAGE_TIMEOUTS = 8;

const JOB_PREFIX = "buddy:buildjob:";
const JOB_ACTIVE_PREFIX = "buddy:buildjob:active:";

// ---------------------------------------------------------------------------
// Artwork markers
// ---------------------------------------------------------------------------

export type ImageKind = "avatar" | "banner" | "background";

/**
 * Markers the copy step may place where it wants AI artwork. Only valid
 * in URL-bearing fields (hero avatarImage, gallery images) — theme colors
 * stay colors. The images step string-replaces each marker with the real
 * IPFS URL.
 */
export const IMAGE_MARKERS: Record<ImageKind, string> = {
  avatar: "__BUDDY_IMAGE_avatar__",
  banner: "__BUDDY_IMAGE_banner__",
  background: "__BUDDY_IMAGE_background__",
};

export type ArtworkSpec = {
  /** The marker string as it appears in the draft. */
  slot: string;
  kind: ImageKind;
  prompt: string;
};

// ---------------------------------------------------------------------------
// Job record
// ---------------------------------------------------------------------------

export type JobStep = "copy" | "images" | "finalize";
export type JobStatus = "active" | "done" | "failed";

export type BuildJob = {
  v: 1;
  id: string;
  /** Lowercase EVM address — must match the session wallet on every step. */
  wallet: string;
  username: string;
  bio: string;
  vibe: string;
  step: JobStep;
  status: JobStatus;
  draft: VoicescapePage | null;
  /** Artwork still to generate (front = next). */
  artwork: ArtworkSpec[];
  artworkTotal: number;
  /** Attempts used on the current front artwork slot (retries, not slots). */
  imgAttempts?: number;
  /**
   * Step-budget timeouts on the current front artwork slot. Timeouts mean
   * the art service was too slow, not broken, so they retry on this
   * separate patient counter and never burn an imgAttempts strike.
   */
  imgTimeouts?: number;
  failReason?: string;
  createdAt: number;
};

function jobKey(id: string): string {
  return `${JOB_PREFIX}${id}`;
}

function activeKey(wallet: string, username: string): string {
  return `${JOB_ACTIVE_PREFIX}${wallet.toLowerCase()}:${username.toLowerCase()}`;
}

async function loadJob(store: KvStore, id: string): Promise<BuildJob | null> {
  const raw = await store.get(jobKey(id));
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as BuildJob;
    if (j?.v !== 1 || typeof j.id !== "string" || j.id !== id) return null;
    if (j.step !== "copy" && j.step !== "images" && j.step !== "finalize")
      return null;
    if (j.status !== "active" && j.status !== "done" && j.status !== "failed")
      return null;
    if (typeof j.wallet !== "string" || typeof j.username !== "string")
      return null;
    if (j.draft !== null && !isValidPage(j.draft)) return null;
    if (!Array.isArray(j.artwork)) return null;
    return j;
  } catch {
    return null;
  }
}

async function saveJob(store: KvStore, job: BuildJob): Promise<void> {
  await store.set(jobKey(job.id), JSON.stringify(job), JOB_TTL_MS);
}

// ---------------------------------------------------------------------------
// Job-start token (HMAC, wallet-bound, expiring)
// ---------------------------------------------------------------------------

export type JobStartClaim = {
  wallet: string;
  u: string;
  b: string;
  v: string;
  exp: number;
};

function getSecret(): string {
  return (process.env.SESSION_SECRET ?? "").trim();
}

/**
 * Sign the collected build slots into a job-start token for the widget.
 * Returns "" when no secret is configured (async builds stay off).
 */
export function signJobStartToken(input: {
  wallet: string;
  u: string;
  b: string;
  v: string;
}): string {
  const secret = getSecret();
  if (!secret) return "";
  const claim: JobStartClaim = {
    wallet: input.wallet.toLowerCase(),
    u: input.u,
    b: input.b,
    v: input.v,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(claim), "utf8").toString(
    "base64url"
  );
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `bj1.${payload}.${sig}`;
}

/**
 * Verify a widget-supplied job-start token. Returns the claim, or null
 * when missing, malformed, tampered, expired, or signed with a different
 * secret. Never throws.
 */
export function verifyJobStartToken(token: unknown): JobStartClaim | null {
  if (typeof token !== "string" || !token.startsWith("bj1.")) return null;
  const secret = getSecret();
  if (!secret) return null;
  const rest = token.slice(4);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  let expected: string;
  try {
    expected = createHmac("sha256", secret).update(payload).digest("base64url");
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
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.wallet !== "string" || !/^0x[0-9a-f]{40}$/.test(r.wallet))
    return null;
  if (
    typeof r.u !== "string" ||
    typeof r.b !== "string" ||
    typeof r.v !== "string" ||
    !r.u ||
    !r.b ||
    !r.v
  )
    return null;
  if (typeof r.exp !== "number" || r.exp < Date.now()) return null;
  return { wallet: r.wallet, u: r.u, b: r.b, v: r.v, exp: r.exp };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export type StartResult =
  | { ok: true; jobId: string; step: JobStep; resumed: boolean }
  | {
      ok: false;
      error: "bad_token" | "unpaid" | "store_unavailable";
      reason?: string;
    };

/**
 * Start (or resume) a paid-build job. Verifies the token against the
 * session wallet, requires an unspent 5-HBAR build payment, and reuses an
 * in-flight job for the same wallet+username instead of duplicating it.
 * Never consumes the payment — that happens only in finalize.
 */
export async function startBuildJob(
  token: unknown,
  sessionWallet: string,
  store: KvStore = getKvStore()
): Promise<StartResult> {
  const wallet = sessionWallet.toLowerCase();
  const claim = verifyJobStartToken(token);
  if (!claim || claim.wallet !== wallet) {
    return { ok: false, error: "bad_token" };
  }
  let access;
  try {
    access = await checkBuildAccess(wallet, store);
  } catch {
    return { ok: false, error: "store_unavailable" };
  }
  if (!access.allowed) {
    return { ok: false, error: "unpaid", reason: access.reason };
  }
  try {
    const existingId = await store.get(activeKey(wallet, claim.u));
    if (existingId) {
      const existing = await loadJob(store, existingId);
      if (
        existing &&
        existing.status === "active" &&
        existing.wallet === wallet
      ) {
        return {
          ok: true,
          jobId: existing.id,
          step: existing.step,
          resumed: true,
        };
      }
    }
  } catch {
    return { ok: false, error: "store_unavailable" };
  }
  const job: BuildJob = {
    v: 1,
    id: randomUUID(),
    wallet,
    username: claim.u,
    bio: claim.b,
    vibe: claim.v,
    step: "copy",
    status: "active",
    draft: null,
    artwork: [],
    artworkTotal: 0,
    createdAt: Date.now(),
  };
  try {
    await saveJob(store, job);
    await store.set(activeKey(wallet, claim.u), job.id, JOB_TTL_MS);
  } catch {
    return { ok: false, error: "store_unavailable" };
  }
  return { ok: true, jobId: job.id, step: "copy", resumed: false };
}

// ---------------------------------------------------------------------------
// Copy step: one LLM call writes the page JSON (+ artwork specs)
// ---------------------------------------------------------------------------

const ARTWORK_FENCE = /```artwork\s*([\s\S]*?)```/;

function copyPrompt(username: string, bio: string, vibe: string): string {
  return [
    "You are Buddy's page builder. Generate a complete Voicescape blockpage.",
    "Output the page as ONE ```json fenced block matching this schema:",
    '{"version":1,"username":"<lowercase>","theme":{"background":"<hex>","foreground":"<hex>","accent":"<hex>","fontFamily":"<name>"},"blocks":[...]}',
    "Block types (5-8 blocks):",
    '- {"type":"hero","title":"<username>","subtitle":"<tagline>"} — first block, always',
    '- {"type":"bio","text":"<2-3 sentences>"}',
    '- {"type":"links","items":[{"label":"...","url":"https://..."}]}',
    '- {"type":"tipJar","message":"..."}',
    '- {"type":"gallery","images":["<url or emoji>", ...]}',
    '- {"type":"top8","friends":[{"name":"..."}]}',
    "Rules:",
    `- username is "${username}", bio is "${bio}", vibe is "${vibe}". Write all copy in that voice.`,
    "- theme colors MUST match the vibe. fontFamily: a real font name like Inter, Georgia, or monospace.",
    "- avatarEmoji on the hero is fine, but prefer AI artwork (below) for the real build.",
    "ARTWORK (what makes this the paid build): you may request up to 3 AI artworks.",
    "Where you want one, put a marker: __BUDDY_IMAGE_avatar__ in hero avatarImage,",
    "__BUDDY_IMAGE_banner__ as a gallery image, __BUDDY_IMAGE_background__ as a gallery image.",
    "Then in a SEPARATE ```artwork fenced block, list each marker you used:",
    '[{"slot":"__BUDDY_IMAGE_avatar__","kind":"avatar","prompt":"<vivid prompt>"}]',
    "kind is avatar (square), banner (wide), or background. Prompts: vivid, wholesome,",
    "family-friendly, no real people, no text or words in the image. Describe style, colors, mood.",
    "Output ONLY: one short prose sentence, the ```json block, and the ```artwork block.",
  ].join("\n");
}

/** Parse the ```artwork fenced block into validated specs. Never throws. */
function extractArtwork(text: string): ArtworkSpec[] {
  const m = text.match(ARTWORK_FENCE);
  if (!m) return [];
  try {
    const arr: unknown = JSON.parse(m[1]);
    if (!Array.isArray(arr)) return [];
    const out: ArtworkSpec[] = [];
    const markers = new Set(Object.values(IMAGE_MARKERS));
    for (const e of arr) {
      if (!e || typeof e !== "object") continue;
      const r = e as Record<string, unknown>;
      if (typeof r.slot !== "string" || !markers.has(r.slot)) continue;
      if (
        r.kind !== "avatar" &&
        r.kind !== "banner" &&
        r.kind !== "background"
      )
        continue;
      if (typeof r.prompt !== "string") continue;
      const prompt = r.prompt
        .replace(/[\x00-\x1f\x7f]/g, " ")
        .trim()
        .slice(0, 500);
      if (prompt.length < 8) continue;
      if (out.some((s) => s.slot === r.slot)) continue;
      out.push({ slot: r.slot, kind: r.kind, prompt });
      if (out.length >= MAX_ARTWORK) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Fallback artwork specs when the model used markers but skipped the
 * ```artwork block: deterministic prompts from username/vibe, so the
 * images step always has something wholesome to generate.
 */
function fallbackArtwork(
  draft: VoicescapePage,
  username: string,
  vibe: string
): ArtworkSpec[] {
  const text = JSON.stringify(draft);
  const specs: ArtworkSpec[] = [];
  const prompts: Record<ImageKind, string> = {
    avatar: `Square profile avatar for "${username}": ${vibe} style, vibrant, wholesome, no people, no text`,
    banner: `Wide banner artwork for "${username}": ${vibe} style, vibrant, wholesome, no people, no text`,
    background: `Page backdrop texture for "${username}": ${vibe} style, subtle and dark, wholesome, no people, no text`,
  };
  for (const [kind, marker] of Object.entries(IMAGE_MARKERS) as Array<
    [ImageKind, string]
  >) {
    if (text.includes(marker)) {
      specs.push({ slot: marker, kind, prompt: prompts[kind] });
    }
  }
  return specs.slice(0, MAX_ARTWORK);
}

async function defaultRunCopy(
  input: { username: string; bio: string; vibe: string },
  signal: AbortSignal
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY missing");
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "VoicescapeAgent/1.0 (+https://voicescape.vercel.app)",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: COPY_MAX_TOKENS,
      messages: [
        {
          role: "system",
          content: copyPrompt(input.username, input.bio, input.vibe),
        },
        { role: "user", content: `Build the page for @${input.username}.` },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`groq HTTP ${res.status}`);
  const data = (await res.json()) as any;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content) {
    throw new Error("groq returned no content");
  }
  return content;
}

// ---------------------------------------------------------------------------
// Images step: one artwork per call
// ---------------------------------------------------------------------------

async function defaultRunImage(
  kind: ImageKind,
  prompt: string,
  signal: AbortSignal,
  clientIp: string
): Promise<{ url: string } | { error: string; timedOut?: boolean }> {
  const tool = makeImageTool(clientIp);
  const raw = await tool.execute(undefined as never, { signal } as never, {
    kind,
    prompt,
  });
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  // The step controller aborts ONLY when the 45s serverless budget runs out,
  // so an aborted signal here means the art service was too slow — a
  // retryable timeout, not a hard failure.
  const timedOut = signal.aborted === true;
  try {
    const parsed = JSON.parse(text) as { url?: unknown; error?: unknown };
    if (typeof parsed.url === "string" && parsed.url.startsWith("https://")) {
      return { url: parsed.url };
    }
    return {
      error:
        typeof parsed.error === "string"
          ? parsed.error
          : "image generation failed",
      ...(timedOut ? { timedOut: true as const } : {}),
    };
  } catch {
    return { error: "image generation failed", ...(timedOut ? { timedOut: true as const } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

export type JobDeps = {
  store?: KvStore;
  runCopy?: (
    input: { username: string; bio: string; vibe: string },
    signal: AbortSignal
  ) => Promise<string>;
  runImage?: (
    kind: ImageKind,
    prompt: string,
    signal: AbortSignal
  ) => Promise<{ url: string } | { error: string; timedOut?: boolean }>;
  spend?: (wallet: string, store: KvStore) => Promise<boolean>;
  clientIp?: string;
};

export type StepResult =
  | { ok: true; done: false; step: JobStep; progress: number; note: string }
  | { ok: true; done: true; draft: VoicescapePage; note: string }
  | {
      ok: false;
      error: "job_not_found" | "forbidden" | "failed" | "store_unavailable";
      reason?: string;
    };

const STEP_NOTES: Record<JobStep, string> = {
  copy: "Drafting your page…",
  images: "Painting custom artwork…",
  finalize: "Finalizing your build…",
};

/**
 * Run one build step. Each step is bounded to STEP_BUDGET_MS so no
 * invocation nears the platform limit; a timed-out step leaves the job
 * active and the widget retries it. The payment is consumed only in
 * finalize, after the draft validates — failed attempts never consume.
 */
export async function stepBuildJob(
  jobId: string,
  sessionWallet: string,
  deps: JobDeps = {}
): Promise<StepResult> {
  const store = deps.store ?? getKvStore();
  const wallet = sessionWallet.toLowerCase();
  let job: BuildJob | null;
  try {
    job = await loadJob(store, jobId);
  } catch {
    return { ok: false, error: "store_unavailable" };
  }
  if (!job) return { ok: false, error: "job_not_found" };
  if (job.wallet !== wallet) return { ok: false, error: "forbidden" };
  // Idempotent completion: a finished job replays its draft.
  if (job.status === "done" && job.draft) {
    return { ok: true, done: true, draft: job.draft, note: "Your page is ready!" };
  }
  if (job.status === "failed") {
    return {
      ok: false,
      error: "failed",
      reason: job.failReason ?? "The build failed — nothing was charged.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEP_BUDGET_MS);
  try {
    if (job.step === "copy") {
      return await runCopyStep(job, store, deps, controller.signal);
    }
    if (job.step === "images") {
      return await runImagesStep(job, store, deps, controller.signal);
    }
    return await runFinalizeStep(job, store, deps);
  } catch (e) {
    // Copy/images steps are safe to retry: no draft is final and nothing
    // was consumed (only finalize spends). Keep the job active so the
    // widget retries the same step — a transient Groq/Pollinations/Pinata
    // failure must never kill a paid build. The widget caps polling and
    // tells the visitor to say "go" again; start is idempotent, so the
    // same job simply resumes.
    if (job.step === "copy" || job.step === "images") {
      return {
        ok: true,
        done: false,
        step: job.step,
        progress: stepProgress(job),
        note: STEP_NOTES[job.step],
      };
    }
    return {
      ok: false,
      error: "failed",
      reason: "A build step failed — nothing was charged.",
    };
  } finally {
    clearTimeout(timer);
  }
}

function stepProgress(job: BuildJob): number {
  if (job.step === "copy") return 0.2;
  if (job.step === "images") {
    const total = Math.max(1, job.artworkTotal);
    const doneCount = total - job.artwork.length;
    return 0.3 + 0.4 * (doneCount / total);
  }
  return 0.85;
}

async function runCopyStep(
  job: BuildJob,
  store: KvStore,
  deps: JobDeps,
  signal: AbortSignal
): Promise<StepResult> {
  const runCopy = deps.runCopy ?? defaultRunCopy;
  const text = await runCopy(
    { username: job.username, bio: job.bio, vibe: job.vibe },
    signal
  );
  const draft = extractPageDraft(text);
  if (!draft) {
    // No valid draft this attempt — stay on copy so the widget retries.
    // The payment is untouched: only finalize consumes.
    return {
      ok: true,
      done: false,
      step: "copy",
      progress: 0.15,
      note: "Drafting your page…",
    };
  }
  const serialized = JSON.stringify(draft);
  let artwork = extractArtwork(text).filter((a) => serialized.includes(a.slot));
  if (artwork.length === 0) {
    artwork = fallbackArtwork(draft, job.username, job.vibe);
  }
  artwork = artwork.slice(0, MAX_ARTWORK);
  job.draft = draft;
  job.artwork = artwork;
  job.artworkTotal = artwork.length;
  job.step = artwork.length > 0 ? "images" : "finalize";
  await saveJob(store, job);
  return {
    ok: true,
    done: false,
    step: job.step,
    progress: 0.3,
    note:
      artwork.length > 0
        ? `Draft ready — painting ${artwork.length} custom artwork…`
        : "Draft ready — finalizing…",
  };
}

async function runImagesStep(
  job: BuildJob,
  store: KvStore,
  deps: JobDeps,
  signal: AbortSignal
): Promise<StepResult> {
  if (!job.draft) {
    // Shouldn't happen — rewind to copy rather than failing the build.
    job.step = "copy";
    await saveJob(store, job);
    return {
      ok: true,
      done: false,
      step: "copy",
      progress: 0.15,
      note: STEP_NOTES.copy,
    };
  }
  const next = job.artwork[0];
  if (!next) {
    job.step = "finalize";
    await saveJob(store, job);
    return {
      ok: true,
      done: false,
      step: "finalize",
      progress: 0.75,
      note: STEP_NOTES.finalize,
    };
  }
  const runImage =
    deps.runImage ??
    ((kind: ImageKind, prompt: string, s: AbortSignal) =>
      defaultRunImage(kind, prompt, s, deps.clientIp ?? "unknown"));
  const result = await runImage(next.kind, next.prompt, signal);
  if (!("url" in result)) {
    if (result.timedOut === true) {
      // Slow art service, not a broken build: the 45s step budget ran out
      // while Pollinations was still painting (cold model). Retry on the
      // patient counter — this never burns a hard-error strike and never
      // consumes anything. The slot stays at the front of the queue.
      const timeouts = (job.imgTimeouts ?? 0) + 1;
      job.imgTimeouts = timeouts;
      await saveJob(store, job);
      if (timeouts >= MAX_IMAGE_TIMEOUTS) {
        return await failJob(
          job,
          store,
          "The art service is taking too long right now — nothing was charged. " +
            "Your 5 HBAR credit is still available; try \u201cgo\u201d again in a little while."
        );
      }
      return {
        ok: true,
        done: false,
        step: "images",
        progress: stepProgress(job),
        note: "Still painting — the art service is slow right now, hanging in there…",
      };
    }
    // Artwork failed: keep the slot at the front, count the attempt, and
    // let the widget retry it on the next poll. A failed artwork must never
    // silently become an empty image on a paid page — after MAX attempts
    // the job fails WITHOUT consuming the payment, so the credit stays
    // available for a fresh "go".
    const attempts = (job.imgAttempts ?? 0) + 1;
    job.imgAttempts = attempts;
    await saveJob(store, job);
    if (attempts >= MAX_IMAGE_ATTEMPTS) {
      return await failJob(
        job,
        store,
        "The artwork service kept failing — nothing was charged. " +
          "Your 5 HBAR credit is still available; say \u201cgo\u201d again to retry."
      );
    }
    return {
      ok: true,
      done: false,
      step: "images",
      progress: stepProgress(job),
      note: `Artwork hiccup — retrying (${attempts}/${MAX_IMAGE_ATTEMPTS})…`,
    };
  }
  // Fill the marker deterministically from the draft: a retried step finds
  // the slot already filled and moves on, so artwork is never generated
  // twice for the same slot.
  job.imgAttempts = 0;
  job.imgTimeouts = 0;
  const serialized = JSON.stringify(job.draft);
  const updated = serialized.split(next.slot).join(result.url);
  try {
    const parsed: unknown = JSON.parse(updated);
    if (isValidPage(parsed)) job.draft = parsed;
  } catch {
    // Keep the previous draft — the marker stays and the step retries.
    return {
      ok: true,
      done: false,
      step: "images",
      progress: stepProgress(job),
      note: STEP_NOTES.images,
    };
  }
  job.artwork = job.artwork.slice(1);
  if (job.artwork.length === 0) job.step = "finalize";
  await saveJob(store, job);
  const doneCount = job.artworkTotal - job.artwork.length;
  return {
    ok: true,
    done: false,
    step: job.step,
    progress: 0.3 + 0.4 * (doneCount / Math.max(1, job.artworkTotal)),
    note: `Painting custom artwork (${doneCount}/${job.artworkTotal})…`,
  };
}

async function runFinalizeStep(
  job: BuildJob,
  store: KvStore,
  deps: JobDeps
): Promise<StepResult> {
  if (!job.draft || !isValidPage(job.draft)) {
    return await failJob(
      job,
      store,
      "The build produced an invalid page — nothing was charged."
    );
  }
  // The ONLY place the payment is consumed: after a valid draft exists.
  // The atomic spend claim makes this exactly-once even if two jobs race.
  const spend = deps.spend ?? ((w: string, s: KvStore) => consumeBuild(w, s));
  let spent: boolean;
  try {
    spent = await spend(job.wallet, store);
  } catch {
    return { ok: false, error: "store_unavailable" };
  }
  if (!spent) {
    return await failJob(job, store, BUILD_RACE_MESSAGE);
  }
  job.status = "done";
  try {
    await store.del(activeKey(job.wallet, job.username));
  } catch {
    // Non-fatal: the TTL cleans it up; a stale index only risks a
    // resumed-poll hitting a done job, which replays idempotently.
  }
  await saveJob(store, job);
  return {
    ok: true,
    done: true,
    draft: job.draft,
    note: "Your page is ready!",
  };
}

async function failJob(
  job: BuildJob,
  store: KvStore,
  reason: string
): Promise<StepResult> {
  job.status = "failed";
  job.failReason = reason;
  try {
    await store.del(activeKey(job.wallet, job.username));
  } catch {
    /* TTL cleans it up */
  }
  try {
    await saveJob(store, job);
  } catch {
    /* the failure stands even if the record doesn't persist */
  }
  return { ok: false, error: "failed", reason };
}
