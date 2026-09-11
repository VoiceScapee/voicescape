/**
 * Voicescape Town Hall — ephemeral presence ("who's here now").
 *
 * Presence deliberately does NOT go on HCS: per-tab heartbeats would cost
 * HBAR per ping and permanently spam an immutable consensus log. Instead
 * the browser pings every ~30s and the server keeps one JSON array per
 * scope in the shared KvStore with a 60s TTL — entries expire on their own
 * when tabs close. Approximate by design; exactness doesn't matter here.
 *
 * All pure logic (merge/count) is unit-testable; the KvStore wrappers are
 * thin and fail-open (presence must never break a page).
 */

import { getKvStore } from "./store";

/** Presence entries expire this long after their last ping. */
export const PRESENCE_TTL_MS = 60_000;

/** Bound the per-scope array so one hot room can't grow a value forever. */
export const PRESENCE_MAX_ENTRIES = 500;

export interface PresenceEntry {
  id: string;
  ts: number;
}

function validEntries(raw: string | null): PresenceEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PresenceEntry =>
        !!e && typeof e === "object" &&
        typeof (e as PresenceEntry).id === "string" &&
        typeof (e as PresenceEntry).ts === "number",
    );
  } catch {
    return [];
  }
}

/**
 * Merge one heartbeat into the stored array: refresh `id`, drop expired
 * entries, cap length. Pure — the route wrapper handles the KvStore I/O.
 */
export function mergePresence(raw: string | null, id: string, nowMs: number): PresenceEntry[] {
  const fresh = validEntries(raw).filter(
    (e) => e.id !== id && nowMs - e.ts < PRESENCE_TTL_MS,
  );
  fresh.push({ id, ts: nowMs });
  return fresh.slice(-PRESENCE_MAX_ENTRIES);
}

/** Count unexpired entries in a stored array. Pure. */
export function countPresence(raw: string | null, nowMs: number): number {
  return validEntries(raw).filter((e) => nowMs - e.ts < PRESENCE_TTL_MS).length;
}

/** Scopes look like `chat:lobby`, `forum:general`, `polls`, `marketplace`. */
export function isValidPresenceScope(scope: unknown): scope is string {
  return typeof scope === "string" && /^[a-z0-9][a-z0-9:_\-./]{0,63}$/i.test(scope);
}

/** Client-supplied identity: `user:<name>` or a random `tab-<id>`. */
export function isValidPresenceId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9:_\-.]{1,64}$/.test(id);
}

function presenceKey(scope: string): string {
  return `presence:${scope.toLowerCase()}`;
}

/** Record a heartbeat; resolves with the current (approximate) headcount. */
export async function pingPresence(scope: string, id: string): Promise<number> {
  const store = getKvStore();
  const key = presenceKey(scope);
  const raw = await store.get(key);
  const merged = mergePresence(raw, id, Date.now());
  await store.set(key, JSON.stringify(merged), PRESENCE_TTL_MS);
  return merged.length;
}

/** Current (approximate) headcount for a scope. */
export async function getPresenceCount(scope: string): Promise<number> {
  const raw = await getKvStore().get(presenceKey(scope));
  return countPresence(raw, Date.now());
}
