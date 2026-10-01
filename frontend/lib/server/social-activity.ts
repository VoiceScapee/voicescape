/**
 * Social activity log — the real-data source for the X and Discord
 * constellation nodes on Danny's Vision.
 *
 * Producer pipes (real posting paths call these when they actually send
 * a post — never for scheduled, queued, or failed posts):
 *   A. Dapp-side: POST /api/social/activity/log
 *        Body: { platform: "x"|"discord", summary: string (<=300 chars),
 *                ts?: ISO string }
 *        Auth: Authorization: Bearer <SOCIAL_LOG_TOKEN> (server env var;
 *        fails closed with 401 when unset). Rate-limited per IP.
 *        Example:
 *          curl -X POST https://voicescape.vercel.app/api/social/activity/log \
 *            -H "Authorization: Bearer $SOCIAL_LOG_TOKEN" \
 *            -H "Content-Type: application/json" \
 *            -d '{"platform":"discord","summary":"posted the daily ship log"}'
 *        The endpoint only records — it never posts anything itself.
 *   B. VM-side: ~/workspace/ops/social-log/log_social.py — writes the
 *        gist sink directly (platform + timestamp only, via the `gh`
 *        CLI); the sink the bots can always reach.
 *
 * The dapp reads via readMergedSocialActivity(). Two sinks, merged
 * newest-first:
 *   1. The shared KV store (Upstash on Vercel, self-hosted Valkey, or the
 *      in-memory fallback) — primary; holds a short summary that stays
 *      server-side.
 *   2. The public gist `social.json` (same gist as the God's Eye feed) —
 *      platform + timestamp ONLY, never post text. Written by the VM-side
 *      logger through the `gh` CLI; the sink the bots can always reach.
 * Dedupe is on platform+timestamp, so an event logged to both sinks
 * appears once.
 *
 * The public API contract stays CONTENT-FREE (platform + ts only):
 * Brandon's rule — no X/Discord post text, captions, or previews ever
 * leave the server.
 *
 * The KV list is capped at 50 with a 7-day TTL refreshed on every write
 * (the store's mandatory-TTL pattern — nothing here lives forever).
 * Automation is paused, so both sinks are empty until posting resumes;
 * the constellation renders those nodes quiet, which is the honest state.
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

/** Public gist shared with the God's Eye feed; hosts social.json. */
export const SOCIAL_GIST_ID = "b588cd71644df34755ac75af42515d27";
const SOCIAL_GIST_RAW = `https://gist.githubusercontent.com/VoiceScapee/${SOCIAL_GIST_ID}/raw/social.json`;

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

/** Shape check for the gist rows — platform + ts only, never trusted blindly. */
function parseGistRows(raw: string | null): SocialEvent[] {
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (e): e is { platform: SocialPlatform; ts: string } =>
          !!e &&
          typeof e === "object" &&
          ((e as { platform: unknown }).platform === "x" ||
            (e as { platform: unknown }).platform === "discord") &&
          typeof (e as { ts: unknown }).ts === "string",
      )
      .map((e) => ({ platform: e.platform, summary: "", ts: e.ts }));
  } catch {
    return [];
  }
}

/**
 * Record that one of our bots actually posted. Called by the real
 * posting paths — either the dapp-side producer pipe
 * (POST /api/social/activity/log, which validates the body and calls
 * this) or the VM-side logger — never by timers or the page itself.
 * Logging-only: a store failure rejects, and the caller decides whether
 * that matters (posting already succeeded).
 *
 * `ts` is optional: when a producer supplies a validated ISO timestamp
 * (the moment the post was confirmed live) it is used as-is; otherwise
 * the server stamps arrival time.
 */
export async function logSocialPost(
  platform: SocialPlatform,
  summary: string,
  ts?: string,
): Promise<void> {
  const store = getKvStore();
  const events = parse(await store.get(SOCIAL_ACTIVITY_KEY));
  events.unshift({
    platform,
    summary: summary.slice(0, 140),
    ts: ts ?? new Date().toISOString(),
  });
  await store.set(
    SOCIAL_ACTIVITY_KEY,
    JSON.stringify(events.slice(0, SOCIAL_ACTIVITY_MAX)),
    SOCIAL_ACTIVITY_TTL_MS,
  );
}

/** Newest-first recent bot posts from the KV store, capped. */
export async function readSocialActivity(
  limit = 20,
): Promise<SocialEvent[]> {
  const store = getKvStore();
  const events = parse(await store.get(SOCIAL_ACTIVITY_KEY));
  const n = Math.max(1, Math.min(limit, SOCIAL_ACTIVITY_MAX));
  return events.slice(0, n);
}

/**
 * Recent bot posts from the public gist sink (platform + ts only).
 * Fail-soft: any fetch or shape problem yields an empty list.
 */
export async function readGistSocialActivity(
  limit = 20,
): Promise<SocialEvent[]> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch(SOCIAL_GIST_RAW, {
      cache: "no-store",
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return [];
    const events = parseGistRows(await r.text());
    const n = Math.max(1, Math.min(limit, SOCIAL_ACTIVITY_MAX));
    return events.slice(0, n);
  } catch {
    return [];
  }
}

function eventTimeMs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Newest-first recent bot posts merged across both sinks, deduped on
 * platform+timestamp. This is what /api/social/activity serves.
 */
export async function readMergedSocialActivity(
  limit = 20,
): Promise<SocialEvent[]> {
  const [kv, gist] = await Promise.all([
    readSocialActivity(SOCIAL_ACTIVITY_MAX),
    readGistSocialActivity(SOCIAL_ACTIVITY_MAX),
  ]);
  const seen = new Set<string>();
  const merged: SocialEvent[] = [];
  for (const e of [...kv, ...gist]) {
    const key = `${e.platform}:${e.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  merged.sort((a, b) => eventTimeMs(b.ts) - eventTimeMs(a.ts));
  const n = Math.max(1, Math.min(limit, SOCIAL_ACTIVITY_MAX));
  return merged.slice(0, n);
}
