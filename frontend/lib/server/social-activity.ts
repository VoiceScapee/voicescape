/**
 * Social activity log — the real-data source for the X and Discord
 * constellation nodes on Danny's Vision.
 *
 * Bot posting paths call logSocialPost() when they actually send a post;
 * the dapp reads via readSocialActivity(). Backed by the shared KV store
 * (Upstash on Vercel, self-hosted Valkey, or the in-memory fallback), so
 * the API route sees the same data the bots wrote — never the local
 * filesystem, which Vercel serverless functions cannot reach.
 *
 * One key holds a JSON array of the most recent events, capped at 50,
 * with a 7-day TTL refreshed on every write (the store's mandatory-TTL
 * pattern — nothing here lives forever). Automation is paused, so this
 * is empty until posting resumes; the constellation renders those nodes
 * quiet, which is the honest state. No "not wired yet" teasing.
 */

import { getKvStore } from "./store";

export type SocialPlatform = "x" | "discord";

export interface SocialEvent {
  platform: SocialPlatform;
  /** Short internal description of the post. Server-side only — the public
   *  API strips this field (Brandon's rule: no X/Discord post text, captions,
   *  or previews ever leave the server). */
  summary: string;
  /** ISO timestamp of when the post was sent. */
  ts: string;
}

/** Single key for the capped recent-events list. */
export const SOCIAL_ACTIVITY_KEY = "social:activity:v1";
/** Hard cap on stored events — the list never grows unbounded. */
export const SOCIAL_ACTIVITY_MAX = 50;
/** Events age out after 7 days. */
export const SOCIAL_ACTIVITY_TTL_MS = 7 * 24 * 3600 * 1000;

function parse(raw: string | null): SocialEvent[] {
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e): e is SocialEvent =>
        !!e &&
        typeof e === "object" &&
        ((e as SocialEvent).platform === "x" ||
          (e as SocialEvent).platform === "discord") &&
        typeof (e as SocialEvent).summary === "string" &&
        typeof (e as SocialEvent).ts === "string",
    );
  } catch {
    // Corrupt value: treat as empty rather than failing the page.
    return [];
  }
}

/**
 * Record that one of our bots actually posted. Called by the real
 * posting paths (Discord bot CLI, X automation) — never by timers or
 * the page itself. Logging-only: a store failure rejects, and the
 * caller decides whether that matters (posting already succeeded).
 */
export async function logSocialPost(
  platform: SocialPlatform,
  summary: string,
): Promise<void> {
  const store = getKvStore();
  const events = parse(await store.get(SOCIAL_ACTIVITY_KEY));
  events.unshift({
    platform,
    summary: summary.slice(0, 140),
    ts: new Date().toISOString(),
  });
  await store.set(
    SOCIAL_ACTIVITY_KEY,
    JSON.stringify(events.slice(0, SOCIAL_ACTIVITY_MAX)),
    SOCIAL_ACTIVITY_TTL_MS,
  );
}

/** Newest-first recent bot posts, capped. Empty until automation resumes. */
export async function readSocialActivity(
  limit = 20,
): Promise<SocialEvent[]> {
  const store = getKvStore();
  const events = parse(await store.get(SOCIAL_ACTIVITY_KEY));
  const n = Math.max(1, Math.min(limit, SOCIAL_ACTIVITY_MAX));
  return events.slice(0, n);
}
