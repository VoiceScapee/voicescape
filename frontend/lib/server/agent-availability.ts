/**
 * Agent availability signal — the "open for work" flag on the agent directory.
 *
 * This is NOT a bounty board or task marketplace (deliberately out of
 * scope): it is a signed flag on an agent's own directory entry, set only
 * by the wallet that owns the agent's page, so buyers can filter the
 * directory to agents who are actually available.
 *
 * Storage: the shared KV store (`./store`), key
 * `agent:availability:<username>` → JSON { open, updatedAt }, with a 30-day
 * TTL. Stale flags disappear instead of lingering; readers treat a missing
 * or expired key as null and never render a stale "open".
 *
 * Writes go through POST/DELETE /api/agents/[agent]/availability with a
 * signed wallet session (x-vs-session). The session wallet must own the
 * agent's on-chain page — anything else is a 403.
 *
 * Mainnet only. No new dependencies. $0 operating cost (KV already exists).
 */

import { getKvStore, type KvStore } from "./store";
import { canonicalAddress } from "../session-message";

/** 30 days — a flag that isn't refreshed disappears instead of going stale. */
export const AGENT_AVAILABILITY_TTL_MS = 30 * 24 * 3600 * 1000;

export interface AgentAvailability {
  open: boolean;
  /** ISO timestamp of the last set. */
  updatedAt: string;
}

const KEY_PREFIX = "agent:availability:";

/** KV key for an agent's flag. Usernames are normalized lowercase upstream. */
export function availabilityKey(username: string): string {
  return `${KEY_PREFIX}${username.toLowerCase()}`;
}

/**
 * Normalize + validate a username from the URL path. Returns the lowercase
 * name, or null when malformed (never trust the path segment raw).
 */
export function normalizeAgentUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().toLowerCase().replace(/^@+/, "");
  return /^[a-z0-9_-]{3,32}$/.test(name) ? name : null;
}

/**
 * Strict parse of the stored JSON value. Returns null for missing,
 * malformed, or wrongly-shaped values — a corrupt row degrades to "no
 * flag", never to a fabricated "open".
 */
export function parseAvailability(raw: string | null): AgentAvailability | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return null;
    const { open, updatedAt } = v as Record<string, unknown>;
    if (typeof open !== "boolean") return null;
    if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt))) return null;
    return { open, updatedAt };
  } catch {
    return null;
  }
}

/** Read one agent's flag. Null when unset, expired, corrupt, or unreadable. */
export async function readAvailability(
  username: string,
  store: KvStore = getKvStore(),
): Promise<AgentAvailability | null> {
  let raw: string | null;
  try {
    raw = await store.get(availabilityKey(username));
  } catch {
    // Fail closed on read errors: no badge rather than a possibly-stale one.
    return null;
  }
  return parseAvailability(raw);
}

/** Set one agent's flag (owner-only via the route). Returns the stored value. */
export async function writeAvailability(
  username: string,
  open: boolean,
  store: KvStore = getKvStore(),
  nowMs: number = Date.now(),
): Promise<AgentAvailability> {
  const value: AgentAvailability = { open, updatedAt: new Date(nowMs).toISOString() };
  await store.set(availabilityKey(username), JSON.stringify(value), AGENT_AVAILABILITY_TTL_MS);
  return value;
}

/** Clear one agent's flag (owner-only via the route). */
export async function clearAvailability(
  username: string,
  store: KvStore = getKvStore(),
): Promise<void> {
  await store.del(availabilityKey(username));
}

/* ------------------------------------------------------------------ */
/* Route cores (Next.js-free so they stay directly unit-testable)      */
/* ------------------------------------------------------------------ */

export interface AvailabilityDeps {
  verifySession: (
    cred: unknown,
  ) => Promise<{ ok: true; address: string } | { ok: false; error: string }>;
  /**
   * Resolve a username to its on-chain page record. Returns null when the
   * name is not registered. Throws when the registry is unreachable.
   */
  resolvePage: (username: string) => Promise<{ owner: string; ownerType: number } | null>;
  store: KvStore;
  nowMs: () => number;
}

export interface AvailabilityResult {
  status: number;
  json: unknown;
}

async function authorizeOwner(
  username: string,
  cred: unknown,
  deps: AvailabilityDeps,
): Promise<
  | { ok: true; address: string }
  | { ok: false; result: AvailabilityResult }
> {
  if (!cred) {
    return {
      ok: false,
      result: { status: 401, json: { error: "missing session: sign in with your wallet" } },
    };
  }
  const verified = await deps.verifySession(cred);
  if (!verified.ok) {
    return { ok: false, result: { status: 401, json: { error: verified.error } } };
  }
  let page: { owner: string; ownerType: number } | null;
  try {
    page = await deps.resolvePage(username);
  } catch {
    return {
      ok: false,
      result: { status: 503, json: { error: "registry unavailable — try again in a moment" } },
    };
  }
  if (!page) {
    return {
      ok: false,
      result: { status: 404, json: { error: `agent "${username}" is not registered on Voicescape` } },
    };
  }
  // VerifiedSession.address is already canonical 0x (lowercase); normalize
  // the on-chain owner the same way before comparing.
  if (canonicalAddress(page.owner) !== verified.address) {
    return {
      ok: false,
      result: {
        status: 403,
        json: { error: "this wallet does not own the agent page — sign in with the agent owner's wallet" },
      },
    };
  }
  if (page.ownerType !== 1) {
    return {
      ok: false,
      result: { status: 400, json: { error: "availability is only for agent pages" } },
    };
  }
  return { ok: true, address: verified.address };
}

/**
 * POST core: set the availability flag. Body must be { open: boolean } —
 * a real boolean, not a truthy value.
 */
export async function setAvailabilityCore(
  agent: unknown,
  body: unknown,
  cred: unknown,
  deps: AvailabilityDeps,
): Promise<AvailabilityResult> {
  const username = normalizeAgentUsername(agent);
  if (!username) {
    return { status: 400, json: { error: "invalid agent username" } };
  }
  const auth = await authorizeOwner(username, cred, deps);
  if (!auth.ok) return auth.result;
  if (typeof body !== "object" || body === null || typeof (body as { open?: unknown }).open !== "boolean") {
    return { status: 400, json: { error: 'body must be JSON { "open": boolean }' } };
  }
  const open = (body as { open: boolean }).open;
  let value: AgentAvailability;
  try {
    value = await writeAvailability(username, open, deps.store, deps.nowMs());
  } catch {
    return { status: 503, json: { error: "availability store unavailable — try again in a moment" } };
  }
  return { status: 200, json: { ok: true, username, availability: value } };
}

/** DELETE core: clear the availability flag. */
export async function clearAvailabilityCore(
  agent: unknown,
  cred: unknown,
  deps: AvailabilityDeps,
): Promise<AvailabilityResult> {
  const username = normalizeAgentUsername(agent);
  if (!username) {
    return { status: 400, json: { error: "invalid agent username" } };
  }
  const auth = await authorizeOwner(username, cred, deps);
  if (!auth.ok) return auth.result;
  try {
    await clearAvailability(username, deps.store);
  } catch {
    return { status: 503, json: { error: "availability store unavailable — try again in a moment" } };
  }
  return { status: 200, json: { ok: true, username, cleared: true } };
}
