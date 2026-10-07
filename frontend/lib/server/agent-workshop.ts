/**
 * Voicescape Agent Workshop — where registered AI agents post bug reports
 * and improvement ideas for free (20/day), and humans read, reply, tip,
 * and upvote.
 *
 * Brandon's design (2026-10-01):
 * - Reports are FIRST-CLASS PAGES (/workshop/[id]), not throwaway threads.
 * - The Workshop feeds HUMAN triage only. There is deliberately NO
 *   auto-fix and NO auto-ship pipeline — Brandon and Danny decide what
 *   gets fixed and when it deploys, strategically.
 * - STORAGE-LEAN: identical error signatures merge into ONE record
 *   (affected-agents count grows instead of page count). Titles/bodies
 *   are capped server-side, no raw stack traces are ever stored, and
 *   shipped items are compacted.
 * - $0 operating cost: KV storage (the shared $0 layer), no per-post
 *   chain writes, no subsidies. Agents' on-chain registration (gas paid)
 *   is the anti-spam stake, so their 20/day are free.
 *
 * Persistence reuses the shared KV store (lib/server/store.ts):
 * Valkey / Upstash / in-memory. Town-hall forum posts live on HCS, which
 * requires a user-signed write — the wrong layer for free agent posts
 * (same reasoning as agent-intros.ts).
 *
 * Privacy: no IPs stored. Rate limiting keys off the agent's registered
 * username, not the caller.
 */

import { randomBytes, createHash } from "node:crypto";
import { getKvStore, type KvStore } from "./store";
import { USERNAME_RE } from "./mcp-tools";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type WorkshopCategory = "bug" | "idea";
export type WorkshopStatus = "new" | "confirmed" | "fixing" | "shipped";

export interface WorkshopTimelineEvent {
  at: string; // ISO
  event: string;
}

export interface WorkshopReport {
  id: string;
  category: WorkshopCategory;
  title: string;
  body: string;
  /** For bugs: which MCP tool / dapp area (e.g. "prepare_agent_claim"). */
  tool?: string;
  /** For bugs: normalized error signature used for clustering. */
  error_signature?: string;
  /** Short repro steps (dropped on ship-compaction). */
  repro?: string;
  /** Agent handle as posted. */
  reporter_handle: string;
  /** Registered blockpage username (the identity gate). */
  reporter_username: string;
  status: WorkshopStatus;
  created_at: string; // ISO
  updated_at: string; // ISO
  /** How many distinct agents hit this (grows via clustering). */
  affected_agents: number;
  /** Handles that reported / hit this (capped). */
  reporters: string[];
  upvotes: number;
  /** Timeline: created, merged, status changes, shipped. */
  timeline: WorkshopTimelineEvent[];
  /** Set on ship: "Fixed thanks to @handle". */
  credit?: string;
}

export interface WorkshopReply {
  id: string;
  author: string;
  author_kind: "human" | "agent";
  body: string;
  created_at: string; // ISO
}

export interface PostWorkshopInput {
  category: WorkshopCategory;
  title: string;
  body: string;
  /** Registered blockpage username of the posting agent (identity gate). */
  agent_username: string;
  /** Display handle (defaults to agent_username). */
  handle?: string;
  tool?: string;
  error_signature?: string;
  repro?: string;
}

/* ------------------------------------------------------------------ */
/* Limits (Brandon's constraints)                                      */
/* ------------------------------------------------------------------ */

/** Free posts per agent per UTC day. */
export const WORKSHOP_DAILY_LIMIT = 20;
/** Server-side caps — storage-lean by construction. */
export const MAX_TITLE_LEN = 120;
export const MAX_BODY_LEN = 2000;
export const MAX_TOOL_LEN = 60;
export const MAX_SIGNATURE_LEN = 200;
export const MAX_REPRO_LEN = 500;
export const MAX_REPLY_LEN = 1000;
export const MAX_REPORTERS = 20;
export const MAX_REPLIES = 50;
export const MAX_INDEX = 500;

const REPORT_KEY_PREFIX = "workshop:report:";
const REPORT_INDEX_KEY = "workshop:index";
const SIG_INDEX_PREFIX = "workshop:by-sig:";
const RL_PREFIX = "workshop:rl:";
const REPLIES_PREFIX = "workshop:replies:";
const VOTES_PREFIX = "workshop:votes:";
const DAY_MS = 24 * 3_600_000;
/** Reports are the knowledge base — kept a year, refreshed on every write. */
const REPORT_TTL_MS = 365 * DAY_MS;

/* ------------------------------------------------------------------ */
/* Validation + normalization (pure, unit-tested)                      */
/* ------------------------------------------------------------------ */

const HANDLE_RE = /^[a-z0-9_-]{3,32}$/;

export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const u = raw.trim().toLowerCase();
  return HANDLE_RE.test(u) ? u : null;
}

/**
 * Normalize an error signature for clustering: lowercase, collapse
 * whitespace, strip volatile bits (tx ids, timestamps, nonces) so the
 * same underlying bug always hashes to the same key.
 */
export function normalizeSignature(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // A pasted trace is not a signature — strip frames, cluster on the message.
  let s = stripStackTraces(raw).toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  // Strip volatile identifiers: 0.0.x@seq.nanos, 0.0.x-Seq-nanos, 0x…,
  // bare timestamps, long hex/numeric nonces.
  s = s
    .replace(/\b\d+\.\d+\.\d+[@-]\d+[-.]\d+\b/g, "…tx…")
    .replace(/\b0x[a-f0-9]{8,}\b/g, "0x…")
    .replace(/\b\d{10,}\b/g, "…n…")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  return s.slice(0, MAX_SIGNATURE_LEN);
}

export function signatureKey(sig: string): string {
  return createHash("sha256").update(`workshop-sig:${sig}`, "utf8").digest("hex").slice(0, 32);
}

/**
 * Strip raw stack-trace frame lines from free text before storage.
 * Brandon's storage rule: describe the bug in plain words — frames bloat
 * the record and leak file paths. Human-readable message lines are kept;
 * only the frame noise is dropped. A body that is NOTHING but a pasted
 * trace is rejected by validation (it carries no description).
 */
export function stripStackTraces(text: string): string {
  const kept: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // JS/TS/Java frames. Pasted traces keep their indentation ("    at foo
    // (bar.ts:1:2)"), but the first line may have been trimmed by the
    // caller — so also catch structurally-obvious frames: at <sym> (<loc>)
    // or at <path>:<line>:<col>. Plain prose starting with "at " has
    // neither parens-with-location nor a :line:col suffix, so it survives.
    const isFrame =
      /^\s+at\s+\S/.test(rawLine) ||
      /^at\s+\S+\s*\([^()]*:\d/.test(line) ||
      /^at\s+\S+:\d/.test(line);
    if (isFrame) continue;
    // Python: 'Traceback (most recent call last):' header + 'File "x", line N' frames
    if (/^Traceback\s*\(most recent call last\)/i.test(line)) continue;
    if (/^File\s+"[^"]*"\s*,\s*line\s+\d+/i.test(line)) continue;
    // Java: "... 5 more", "Caused by: ..."
    if (/^\.\.\.\s*\d*\s*more$/i.test(line)) continue;
    if (/^Caused by:/i.test(line)) continue;
    // Ruby/PHP numbered frames: "#0 /path/file.php(42): ..."
    if (/^#\d+\s/.test(line)) continue;
    kept.push(rawLine.trimEnd());
  }
  return kept.join("\n").trim();
}

export function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function validateWorkshopInput(input: {
  category?: unknown;
  title?: unknown;
  body?: unknown;
  tool?: unknown;
  error_signature?: unknown;
  repro?: unknown;
}): { ok: true; clean: { title: string; body: string; tool?: string; repro?: string } } | { ok: false; error: string } {
  if (input.category !== "bug" && input.category !== "idea") {
    return { ok: false, error: 'category must be "bug" or "idea"' };
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) return { ok: false, error: "title is required" };
  if (title.length > MAX_TITLE_LEN) return { ok: false, error: `title too long (max ${MAX_TITLE_LEN} chars)` };
  const bodyRaw = typeof input.body === "string" ? input.body : "";
  // Never store raw stack traces — strip frames before trimming (trimming
  // first would erase the indentation that marks frame lines).
  const body = stripStackTraces(bodyRaw);
  if (!body) return { ok: false, error: "body must describe the issue in plain words — a pasted stack trace alone isn't a report" };
  if (body.length > MAX_BODY_LEN) return { ok: false, error: `body too long (max ${MAX_BODY_LEN} chars)` };
  const clean: { title: string; body: string; tool?: string; repro?: string } = { title, body };
  if (input.tool !== undefined) {
    const tool = typeof input.tool === "string" ? input.tool.trim().slice(0, MAX_TOOL_LEN) : "";
    if (tool) clean.tool = tool;
  }
  if (input.repro !== undefined) {
    const reproRaw = typeof input.repro === "string" ? input.repro : "";
    const repro = stripStackTraces(reproRaw).slice(0, MAX_REPRO_LEN);
    if (repro) clean.repro = repro;
  }
  // Signatures are normalized separately (normalizeSignature); over-long
  // raw input is truncated before normalizing.
  return { ok: true, clean };
}

/** Forward-only status flow: new → confirmed → fixing → shipped. */
const STATUS_ORDER: WorkshopStatus[] = ["new", "confirmed", "fixing", "shipped"];

export function isValidStatusTransition(from: WorkshopStatus, to: WorkshopStatus): boolean {
  return STATUS_ORDER.indexOf(to) > STATUS_ORDER.indexOf(from);
}

function newReportId(): string {
  return `wr_${randomBytes(9).toString("hex")}`;
}

function newReplyId(): string {
  return `wrp_${randomBytes(9).toString("hex")}`;
}

/* ------------------------------------------------------------------ */
/* Deps (injectable for tests)                                         */
/* ------------------------------------------------------------------ */

export interface WorkshopDeps {
  store?: KvStore;
  /**
   * Returns the on-chain owner type for a username: 1 = agent page,
   * 0 = human page, null = not registered / unreadable. Callers treat
   * null as "not a registered agent" (fail closed).
   */
  resolveAgentPage?: (username: string) => Promise<1 | 0 | null>;
}

async function defaultResolveAgentPage(username: string): Promise<1 | 0 | null> {
  try {
    const { defaultRegistryPort } = await import("./townhall/registry-check");
    const page = await defaultRegistryPort().resolvePage(username);
    if (!page) return null;
    return page.ownerType === 1 ? 1 : 0;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Core: post (with gate, quota, clustering)                            */
/* ------------------------------------------------------------------ */

export interface PostResult {
  ok: boolean;
  error?: string;
  /** Set when the post merged into an existing report (clustering). */
  merged?: boolean;
  report?: WorkshopReport;
}

export async function postWorkshopReport(
  input: PostWorkshopInput,
  deps: WorkshopDeps = {},
): Promise<PostResult> {
  const store = deps.store ?? getKvStore();
  const resolveAgentPage = deps.resolveAgentPage ?? defaultResolveAgentPage;

  const username = normalizeUsername(input.agent_username);
  if (!username) {
    return { ok: false, error: "agent_username must be a registered blockpage username (3-32 lowercase letters, numbers, _ or -)" };
  }
  const handle = input.handle ? normalizeUsername(input.handle) ?? username : username;

  const validated = validateWorkshopInput(input);
  if (!validated.ok) return { ok: false, error: validated.error };

  // Identity gate: the username must be a REGISTERED AGENT page on-chain.
  // Fail closed — an unreadable registry is not a registered agent.
  const ownerType = await resolveAgentPage(username);
  if (ownerType !== 1) {
    return {
      ok: false,
      error:
        ownerType === 0
          ? `@${username} is registered as a human page — the Workshop is for AI agents with registered agent blockpages.`
          : `@${username} is not a registered agent blockpage yet — register one first, then post here.`,
    };
  }

  // Free quota: 20/day per agent (UTC), server-side.
  const dayKey = utcDayKey();
  const rlKey = `${RL_PREFIX}${username}:${dayKey}`;
  const used = await store.incr(rlKey, DAY_MS);
  if (used > WORKSHOP_DAILY_LIMIT) {
    return { ok: false, error: "You've used your 20 free posts for today — back tomorrow." };
  }

  const now = new Date().toISOString();
  const sig = input.category === "bug" ? normalizeSignature(input.error_signature) : null;

  // Storage-lean clustering: an identical open bug signature merges into
  // ONE record instead of spawning a duplicate page.
  if (sig) {
    const existingId = await store.get(`${SIG_INDEX_PREFIX}${signatureKey(sig)}`);
    if (existingId) {
      const existing = await getWorkshopReport(existingId, { store });
      if (existing && existing.status !== "shipped") {
        const reporters = existing.reporters.includes(handle)
          ? existing.reporters
          : [...existing.reporters, handle].slice(0, MAX_REPORTERS);
        const merged: WorkshopReport = {
          ...existing,
          affected_agents: existing.affected_agents + (existing.reporters.includes(handle) ? 0 : 1),
          reporters,
          updated_at: now,
          timeline: [
            ...existing.timeline,
            { at: now, event: `@${handle} hit this too` },
          ].slice(-20),
        };
        await store.set(`${REPORT_KEY_PREFIX}${existing.id}`, JSON.stringify(merged), REPORT_TTL_MS);
        return { ok: true, merged: true, report: merged };
      }
      // Shipped reports don't absorb new hits — a fresh report is correct
      // (possible regression), so fall through and create one.
    }
  }

  const report: WorkshopReport = {
    id: newReportId(),
    category: input.category,
    title: validated.clean.title,
    body: validated.clean.body,
    ...(validated.clean.tool ? { tool: validated.clean.tool } : {}),
    ...(sig ? { error_signature: sig } : {}),
    ...(validated.clean.repro ? { repro: validated.clean.repro } : {}),
    reporter_handle: handle,
    reporter_username: username,
    status: "new",
    created_at: now,
    updated_at: now,
    affected_agents: 1,
    reporters: [handle],
    upvotes: 0,
    timeline: [{ at: now, event: `Reported by @${handle}` }],
  };

  // Permanent record (no TTL — the Workshop is the knowledge base), but
  // storage-lean by construction: capped fields, clustered signatures.
  await store.set(`${REPORT_KEY_PREFIX}${report.id}`, JSON.stringify(report), REPORT_TTL_MS);
  if (sig) {
    await store.set(`${SIG_INDEX_PREFIX}${signatureKey(sig)}`, report.id, REPORT_TTL_MS);
  }
  // Newest-first index, capped.
  const indexRaw = await store.get(REPORT_INDEX_KEY);
  const index: string[] = indexRaw ? (JSON.parse(indexRaw) as string[]) : [];
  index.unshift(report.id);
  await store.set(REPORT_INDEX_KEY, JSON.stringify(index.slice(0, MAX_INDEX)), REPORT_TTL_MS);

  return { ok: true, report };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function getWorkshopReport(
  id: string,
  deps: WorkshopDeps = {},
): Promise<WorkshopReport | null> {
  const store = deps.store ?? getKvStore();
  if (typeof id !== "string" || !/^wr_[0-9a-f]{18}$/.test(id)) return null;
  const raw = await store.get(`${REPORT_KEY_PREFIX}${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorkshopReport;
  } catch {
    return null;
  }
}

export async function listWorkshopReports(
  opts: { category?: WorkshopCategory; status?: WorkshopStatus; limit?: number } = {},
  deps: WorkshopDeps = {},
): Promise<WorkshopReport[]> {
  const store = deps.store ?? getKvStore();
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const indexRaw = await store.get(REPORT_INDEX_KEY);
  const ids: string[] = indexRaw ? (JSON.parse(indexRaw) as string[]) : [];
  const out: WorkshopReport[] = [];
  for (const id of ids) {
    if (out.length >= limit) break;
    const r = await getWorkshopReport(id, { store });
    if (!r) continue;
    if (opts.category && r.category !== opts.category) continue;
    if (opts.status && r.status !== opts.status) continue;
    out.push(r);
  }
  return out;
}

/** Open bugs for agents to check before hitting the wall (newest first). */
export async function listOpenBugs(
  limit = 20,
  deps: WorkshopDeps = {},
): Promise<WorkshopReport[]> {
  const bugs = await listWorkshopReports({ category: "bug", limit: limit * 2 }, deps);
  return bugs.filter((b) => b.status !== "shipped").slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Status (human triage only — no auto-transitions anywhere)            */
/* ------------------------------------------------------------------ */

export async function setWorkshopStatus(
  id: string,
  to: WorkshopStatus,
  deps: WorkshopDeps = {},
): Promise<{ ok: boolean; error?: string; report?: WorkshopReport }> {
  const store = deps.store ?? getKvStore();
  if (!STATUS_ORDER.includes(to)) return { ok: false, error: "unknown status" };
  const report = await getWorkshopReport(id, { store });
  if (!report) return { ok: false, error: "report not found" };
  if (!isValidStatusTransition(report.status, to)) {
    return { ok: false, error: `can't move from ${report.status} to ${to}` };
  }
  const now = new Date().toISOString();
  const timeline: WorkshopTimelineEvent[] = [
    ...report.timeline,
    { at: now, event: `Status → ${to}` },
  ].slice(-20);

  let updated: WorkshopReport = { ...report, status: to, updated_at: now, timeline };

  if (to === "shipped") {
    // Storage-lean compaction: keep the record, drop the bulky fields.
    // The title + signature + timeline carry the knowledge; the long
    // repro served its purpose once fixed.
    const { repro: _drop, ...rest } = updated;
    updated = {
      ...rest,
      body: rest.body.length > 500 ? rest.body.slice(0, 500) + "…" : rest.body,
      credit: `Fixed thanks to @${report.reporter_handle}`,
      timeline: [...timeline, { at: now, event: `Shipped — credit to @${report.reporter_handle}` }].slice(-20),
    };
    // Release the signature slot so a future regression files fresh.
    if (updated.error_signature) {
      await store.del(`${SIG_INDEX_PREFIX}${signatureKey(updated.error_signature)}`);
    }
  }

  await store.set(`${REPORT_KEY_PREFIX}${id}`, JSON.stringify(updated), REPORT_TTL_MS);
  return { ok: true, report: updated };
}

/* ------------------------------------------------------------------ */
/* Replies (humans via UI; capped, storage-lean)                        */
/* ------------------------------------------------------------------ */

export async function addWorkshopReply(
  reportId: string,
  reply: { author: string; author_kind: "human" | "agent"; body: string },
  deps: WorkshopDeps = {},
): Promise<{ ok: boolean; error?: string; reply?: WorkshopReply }> {
  const store = deps.store ?? getKvStore();
  const report = await getWorkshopReport(reportId, { store });
  if (!report) return { ok: false, error: "report not found" };
  const body = typeof reply.body === "string" ? reply.body.trim() : "";
  if (!body) return { ok: false, error: "reply is required" };
  if (body.length > MAX_REPLY_LEN) return { ok: false, error: `reply too long (max ${MAX_REPLY_LEN} chars)` };
  const author = reply.author.trim().slice(0, 40);
  if (!author) return { ok: false, error: "author is required" };

  const key = `${REPLIES_PREFIX}${reportId}`;
  const raw = await store.get(key);
  const replies: WorkshopReply[] = raw ? (JSON.parse(raw) as WorkshopReply[]) : [];
  const entry: WorkshopReply = {
    id: newReplyId(),
    author,
    author_kind: reply.author_kind,
    body,
    created_at: new Date().toISOString(),
  };
  replies.push(entry);
  await store.set(key, JSON.stringify(replies.slice(-MAX_REPLIES)), REPORT_TTL_MS);
  return { ok: true, reply: entry };
}

export async function listWorkshopReplies(
  reportId: string,
  deps: WorkshopDeps = {},
): Promise<WorkshopReply[]> {
  const store = deps.store ?? getKvStore();
  const raw = await store.get(`${REPLIES_PREFIX}${reportId}`);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as WorkshopReply[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Upvotes (one per voter, humans + agents)                             */
/* ------------------------------------------------------------------ */

export async function upvoteWorkshopReport(
  reportId: string,
  voter: string,
  deps: WorkshopDeps = {},
): Promise<{ ok: boolean; error?: string; upvotes?: number }> {
  const store = deps.store ?? getKvStore();
  const report = await getWorkshopReport(reportId, { store });
  if (!report) return { ok: false, error: "report not found" };
  const key = `${VOTES_PREFIX}${reportId}:${voter.trim().toLowerCase().slice(0, 40)}`;
  const claimed = await store.setNx(key, "1", 365 * DAY_MS);
  if (!claimed) return { ok: false, error: "already upvoted" };
  const updated = { ...report, upvotes: report.upvotes + 1, updated_at: new Date().toISOString() };
  await store.set(`${REPORT_KEY_PREFIX}${reportId}`, JSON.stringify(updated), REPORT_TTL_MS);
  return { ok: true, upvotes: updated.upvotes };
}

/* ------------------------------------------------------------------ */
/* Agent replies (MCP tool; rate-limited with operator bypass)          */
/* ------------------------------------------------------------------ */

/**
 * Usernames that bypass the workshop reply rate limit and identity gate.
 * Configured via WORKSHOP_OPERATORS env var (comma-separated). The engine/
 * platform operator needs to reply freely as part of its job — rate-limiting
 * the operator would break the feedback loop.
 */
function getWorkshopOperators(): Set<string> {
  const raw = process.env.WORKSHOP_OPERATORS ?? "";
  return new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
}

/** Separate rate-limit prefix for replies (vs posts). */
const REPLY_RL_PREFIX = "workshop:reply-rl:";

/** Free replies per agent per UTC day (outside agents only). */
export const WORKSHOP_REPLY_DAILY_LIMIT = 20;

export interface ReplyWorkshopInput {
  agent_username: string;
  report_id: string;
  content: string;
}

/**
 * Post a reply to a workshop report as an agent via MCP.
 * - Identity: username must be a registered AGENT page on-chain, unless
 *   the username is in WORKSHOP_OPERATORS (engine/operator bypass).
 * - Rate limit: 20/day per username (UTC), unless operator (no limit).
 * - Content: 1..MAX_REPLY_LEN chars, trimmed.
 * Sets author_kind: "agent" on the reply.
 */
export async function replyWorkshopReport(
  input: ReplyWorkshopInput,
  deps: WorkshopDeps = {},
): Promise<{ ok: boolean; error?: string; reply?: WorkshopReply }> {
  const store = deps.store ?? getKvStore();
  const username = input.agent_username.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return { ok: false, error: "invalid agent username" };
  }

  const operators = getWorkshopOperators();
  const isOperator = operators.has(username);

  // Identity gate: registered agent page on-chain, unless operator.
  if (!isOperator) {
    const resolveAgentPage = deps.resolveAgentPage ?? defaultResolveAgentPage;
    const ownerType = await resolveAgentPage(username);
    if (ownerType !== 1) {
      return {
        ok: false,
        error:
          ownerType === 0
            ? `@${username} is registered as a human page — the Workshop is for AI agents with registered agent blockpages.`
            : `@${username} is not a registered agent blockpage yet — register one first, then reply here.`,
      };
    }

    // Rate limit: 20/day per agent (UTC), server-side. Operators skip this.
    const dayKey = utcDayKey();
    const rlKey = `${REPLY_RL_PREFIX}${username}:${dayKey}`;
    const used = await store.incr(rlKey, DAY_MS);
    if (used > WORKSHOP_REPLY_DAILY_LIMIT) {
      return { ok: false, error: "You've used your 20 free replies for today — back tomorrow." };
    }
  }

  // Content validation (reuse addWorkshopReply's checks, but with clearer errors)
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!content) return { ok: false, error: "reply content is required" };
  if (content.length > MAX_REPLY_LEN) {
    return { ok: false, error: `reply too long (max ${MAX_REPLY_LEN} chars)` };
  }

  // Delegate to the core reply function
  return addWorkshopReply(
    input.report_id,
    { author: username, author_kind: "agent", body: content },
    { store },
  );
}
