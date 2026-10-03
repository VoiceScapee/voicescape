/**
 * Internal usage telemetry — founder eyes only.
 *
 * Brandon (2026-10-02): "I want you to be able to track how people are
 * using the buddy widget on the dapp and how people are using the
 * blockpage builder... just so we can track errors users might be
 * getting across that we haven't seen."
 *
 * Privacy: aggregate counters + anonymous recent samples. No wallets,
 * no IPs, no user agents, no message text, no usernames. Builder preview
 * snapshots store the draft page JSON only — no identifier — so broken
 * renders can be seen (re-rendered in the dashboard with the same
 * PageRenderer the builder uses) without knowing whose they are.
 * Nothing here leaves the founder-gated /admin/usage dashboard.
 */

export const USAGE_EVENTS = [
  // Buddy widget (AgentChat)
  "buddy.open",
  "buddy.message_sent",
  "buddy.message_failed",
  "buddy.build_started",
  // Builder funnel
  "builder.open",
  "builder.block_add",
  "builder.preview",
  "builder.publish_attempt",
  "builder.publish_success",
  "builder.publish_failed",
] as const;

export type UsageEvent = (typeof USAGE_EVENTS)[number];

/** Coarse, non-identifying context. Never add wallet/IP/username here. */
export interface UsageContext {
  /** e.g. block type for builder.block_add ("hero" | "bio" | ...). */
  detail?: string;
  /** Anonymous session id (random per page load) for sequencing. */
  sid?: string;
}

export interface UsageSample {
  event: UsageEvent;
  detail?: string;
  sid?: string;
  at: number;
}

const EVENT_SET = new Set<string>(USAGE_EVENTS);

export function isUsageEvent(e: unknown): e is UsageEvent {
  return typeof e === "string" && EVENT_SET.has(e);
}

/** Scrub context to the allowlisted shape. */
export function scrubContext(c: unknown): UsageContext {
  if (!c || typeof c !== "object") return {};
  const o = c as Record<string, unknown>;
  const out: UsageContext = {};
  if (typeof o.detail === "string" && o.detail.length <= 64) out.detail = o.detail;
  if (typeof o.sid === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(o.sid)) out.sid = o.sid;
  return out;
}

function dayKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Storage keys. */
const countKey = (event: UsageEvent, day: string) => `usage:count:${day}:${event}`;
const samplesKey = (event: UsageEvent) => `usage:samples:${event}`;
const previewsKey = `usage:previews`;

const SAMPLE_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
const PREVIEW_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const MAX_SAMPLES = 50;
const MAX_PREVIEWS = 20;

/** A builder preview snapshot: anonymous draft page JSON + timestamp. */
export interface PreviewSnapshot {
  page: unknown;
  at: number;
}

export interface UsageStore {
  incrCount(event: UsageEvent, day: string): Promise<void>;
  getCounts(day: string): Promise<Record<string, number>>;
  pushSample(sample: UsageSample): Promise<void>;
  getSamples(event: UsageEvent): Promise<UsageSample[]>;
  pushPreview(page: unknown, at: number): Promise<void>;
  getPreviews(): Promise<PreviewSnapshot[]>;
}

export function createUsageStore(kv: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}): UsageStore {
  return {
    async incrCount(event, day) {
      const k = countKey(event, day);
      const cur = parseInt((await kv.get(k)) ?? "0", 10) || 0;
      await kv.set(k, String(cur + 1), SAMPLE_TTL_MS);
    },
    async getCounts(day) {
      const out: Record<string, number> = {};
      for (const e of USAGE_EVENTS) {
        out[e] = parseInt((await kv.get(countKey(e, day))) ?? "0", 10) || 0;
      }
      return out;
    },
    async pushSample(sample) {
      const k = samplesKey(sample.event);
      let arr: UsageSample[] = [];
      try {
        arr = JSON.parse((await kv.get(k)) ?? "[]");
      } catch {
        arr = [];
      }
      arr.unshift(sample);
      await kv.set(k, JSON.stringify(arr.slice(0, MAX_SAMPLES)), SAMPLE_TTL_MS);
    },
    async getSamples(event) {
      try {
        return JSON.parse((await kv.get(samplesKey(event))) ?? "[]");
      } catch {
        return [];
      }
    },
    async pushPreview(page, at) {
      let arr: PreviewSnapshot[] = [];
      try {
        arr = JSON.parse((await kv.get(previewsKey)) ?? "[]");
      } catch {
        arr = [];
      }
      arr.unshift({ page, at });
      await kv.set(previewsKey, JSON.stringify(arr.slice(0, MAX_PREVIEWS)), PREVIEW_TTL_MS);
    },
    async getPreviews() {
      try {
        return JSON.parse((await kv.get(previewsKey)) ?? "[]");
      } catch {
        return [];
      }
    },
  };
}

export { dayKey };
