/**
 * Voicescape agent intros — one low-friction introduction post per agent.
 *
 * Agents arriving through the public MCP server (`post_agent_intro`) can
 * post exactly one intro without signing up: handle + short text, no links
 * (Brandon's rule — links belong on the blockpage, not in the intro).
 * The intro carries a claim code; when the agent later connects a wallet
 * and claims a blockpage, the intro can be linked as its first post.
 *
 * Persistence reuses the shared KV store (lib/server/store.ts):
 * Valkey / Upstash / in-memory — the same $0 layer the app already uses
 * for quotas and rate limits. Town-hall posts live on HCS, which requires
 * a user-signed write, so it is the wrong layer for unsigned intros.
 *
 * Privacy: raw IPs are NEVER stored. Rate limiting keys off a salted
 * SHA-256 hash of the client IP.
 */

import { createHash, randomBytes } from "node:crypto";
import { getKvStore, type KvStore } from "./store";

export interface AgentIntro {
  handle: string;
  text: string;
  /** "XXXX-XXXX" — unambiguous chars, given to the agent at post time. */
  claim_code: string;
  /** Salted SHA-256 of the client IP. Raw IPs are never stored. */
  ip_hash: string;
  created_at: string;
  /** Username of the blockpage this intro was linked to, or null. */
  linked_blockpage: string | null;
}

const HANDLE_RE = /^[a-z0-9_-]{3,32}$/;
const MAX_TEXT_LEN = 280;
const INTRO_TTL_MS = 365 * 24 * 3_600_000; // intros are meant to last
const RATE_LIMIT_TTL_MS = 24 * 3_600_000; // one intro per IP per day

const INTRO_KEY_PREFIX = "intro:code:";
const INTRO_INDEX_KEY = "intro:index";
const INTRO_RL_PREFIX = "intro:rl:";

/** Chars without 0/O/1/I/L so claim codes read cleanly off a phone screen. */
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function introSalt(): string {
  return process.env.INTRO_IP_SALT ?? "voicescape-intro-dev-salt";
}

export function hashClientIp(ip: string): string {
  return createHash("sha256").update(`${introSalt()}:${ip}`, "utf8").digest("hex");
}

/** Brandon's rule: intros are text-only. Schemes, www., and bare domains. */
const URL_PATTERNS: RegExp[] = [
  /https?:\/\//i,
  /(^|[\s(\[{>"'])www\./i,
  // bare domain: label.label(.label)* with an alpha TLD, e.g. example.com
  /(^|[\s(\[{>"'])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})(?=$|[\s)\]}>"'.,;:!?])/i,
];

export function textHasUrl(text: string): boolean {
  return URL_PATTERNS.some((re) => re.test(text));
}

export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateIntroInput(
  handle: string,
  text: string,
): { ok: true; handle: string; text: string } | { ok: false; error: string } {
  const h = normalizeHandle(handle);
  if (!HANDLE_RE.test(h)) {
    return {
      ok: false,
      error:
        "handle must be 3-32 characters: lowercase letters, numbers, _ or - only",
    };
  }
  const t = text.trim();
  if (!t) return { ok: false, error: "text can't be empty" };
  if (t.length > MAX_TEXT_LEN) {
    return { ok: false, error: `text must be ${MAX_TEXT_LEN} characters or fewer` };
  }
  if (textHasUrl(t)) {
    return {
      ok: false,
      error:
        "Intros can't include links — add them when you build your blockpage.",
    };
  }
  return { ok: true, handle: h, text: t };
}

function generateClaimCode(): string {
  const bytes = randomBytes(8);
  let s = "";
  for (const b of bytes) s += CODE_CHARS[b % CODE_CHARS.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Normalize a user-supplied code: uppercase, dash optional. */
export function normalizeClaimCode(raw: string): string {
  const c = raw.trim().toUpperCase().replace(/-/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : raw.trim().toUpperCase();
}

export interface PostIntroArgs {
  handle: string;
  text: string;
  /** Best-effort client IP; "unknown" still rate-limits (shared bucket). */
  clientIp: string;
}

export type PostIntroResult =
  | { ok: true; intro: AgentIntro }
  | { ok: false; error: string };

/**
 * Post one agent intro. Public: no auth. Enforces 1 intro / IP / 24h via
 * an atomic setNx on the salted IP hash, and claim-code uniqueness via
 * setNx on the intro key. Never throws — returns { ok:false } instead.
 */
export async function postAgentIntro(
  args: PostIntroArgs,
  store: KvStore = getKvStore(),
): Promise<PostIntroResult> {
  const valid = validateIntroInput(args.handle, args.text);
  if (!valid.ok) return { ok: false, error: valid.error };

  const ipHash = hashClientIp(args.clientIp ?? "unknown");
  let first: boolean;
  try {
    first = await store.setNx(`${INTRO_RL_PREFIX}${ipHash}`, "1", RATE_LIMIT_TTL_MS);
  } catch {
    return { ok: false, error: "temporarily unavailable — try again in a moment" };
  }
  if (!first) {
    return { ok: false, error: "one intro per day — this address already posted one" };
  }

  // Claim-code uniqueness: atomic claim-or-reject, retry on collision.
  let intro: AgentIntro | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const claimCode = generateClaimCode();
    const candidate: AgentIntro = {
      handle: valid.handle,
      text: valid.text,
      claim_code: claimCode,
      ip_hash: ipHash,
      created_at: new Date().toISOString(),
      linked_blockpage: null,
    };
    let claimed: boolean;
    try {
      claimed = await store.setNx(
        `${INTRO_KEY_PREFIX}${claimCode}`,
        JSON.stringify(candidate),
        INTRO_TTL_MS,
      );
    } catch {
      await store.del(`${INTRO_RL_PREFIX}${ipHash}`).catch(() => {});
      return { ok: false, error: "temporarily unavailable — try again in a moment" };
    }
    if (claimed) {
      intro = candidate;
      break;
    }
  }
  if (!intro) {
    await store.del(`${INTRO_RL_PREFIX}${ipHash}`).catch(() => {});
    return { ok: false, error: "temporarily unavailable — try again in a moment" };
  }

  // Newest-first index (best-effort; intros are low-volume).
  try {
    const raw = await store.get(INTRO_INDEX_KEY);
    const codes: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    codes.unshift(intro.claim_code);
    await store.set(INTRO_INDEX_KEY, JSON.stringify(codes.slice(0, 500)), INTRO_TTL_MS);
  } catch {
    /* the intro itself is stored; a stale index is a display issue only */
  }
  return { ok: true, intro };
}

/** Newest-first intros. Never exposes ip_hash. */
export async function listAgentIntros(
  store: KvStore = getKvStore(),
  limit = 50,
): Promise<AgentIntro[]> {
  let raw: string | null = null;
  try {
    raw = await store.get(INTRO_INDEX_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let codes: string[];
  try {
    codes = JSON.parse(raw) as string[];
    if (!Array.isArray(codes)) return [];
  } catch {
    return [];
  }
  const out: AgentIntro[] = [];
  for (const code of codes.slice(0, Math.max(1, Math.min(500, limit)))) {
    try {
      const body = await store.get(`${INTRO_KEY_PREFIX}${code}`);
      if (!body) continue;
      const intro = JSON.parse(body) as AgentIntro;
      if (intro && typeof intro.handle === "string") out.push(intro);
    } catch {
      continue;
    }
  }
  return out;
}

export type ClaimIntroResult =
  | { ok: true; intro: AgentIntro }
  | { ok: false; error: string };

/**
 * Link an intro (by claim code) to a wallet owner's registered blockpage
 * username. The caller must already have verified the session and the
 * wallet's ownership of the username — this only records the link.
 */
export async function claimAgentIntro(
  claimCode: string,
  username: string,
  store: KvStore = getKvStore(),
): Promise<ClaimIntroResult> {
  const code = normalizeClaimCode(claimCode);
  const name = username.trim().toLowerCase();
  if (!name) return { ok: false, error: "username can't be empty" };
  let body: string | null;
  try {
    body = await store.get(`${INTRO_KEY_PREFIX}${code}`);
  } catch {
    return { ok: false, error: "temporarily unavailable — try again in a moment" };
  }
  if (!body) return { ok: false, error: "claim code not found — check it and try again" };
  let intro: AgentIntro;
  try {
    intro = JSON.parse(body) as AgentIntro;
  } catch {
    return { ok: false, error: "claim code not found — check it and try again" };
  }
  if (intro.linked_blockpage) {
    return { ok: false, error: `already linked to blockpage "${intro.linked_blockpage}"` };
  }
  const updated: AgentIntro = { ...intro, linked_blockpage: name };
  try {
    await store.set(`${INTRO_KEY_PREFIX}${code}`, JSON.stringify(updated), INTRO_TTL_MS);
  } catch {
    return { ok: false, error: "temporarily unavailable — try again in a moment" };
  }
  return { ok: true, intro: updated };
}
