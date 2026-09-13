/**
 * Privacy-safe aggregate conversion telemetry.
 *
 * Paid actions (tips, marketplace purchases) and key engagement actions
 * (votes, proposals, chat sends) are the app's vital signs — but tracking
 * them per user would violate the wallet-only, no-personal-data rule.
 * So this module stores AGGREGATE COUNTERS ONLY:
 *
 *   metrics:daily:<YYYY-MM-DD>:<event> → count (7-day TTL)
 *
 * Never stored: wallet addresses, IPs, user agents, pages, tx ids, or any
 * per-user/per-session record. The event name comes from a strict allowlist;
 * anything else is dropped. IP is used transiently for rate limiting only
 * (see the /api/metrics route) and never persisted.
 *
 * Telemetry always fails open: recording never throws and never affects the
 * payment UX — a metrics failure is silently dropped.
 */

import type { KvStore } from "./store";
import { getKvStore } from "./store";
import { isFounderWallet } from "./client-errors";

/** The only event names the API will count. Keep this list tight. */
export const CONVERSION_EVENTS = [
  "tip_attempt",
  "tip_confirmed",
  "tip_failed",
  "purchase_attempt",
  "purchase_confirmed",
  "purchase_failed",
  "vote_submitted",
  "vote_failed",
  "proposal_submitted",
  "proposal_failed",
  "chat_sent",
  "chat_failed",
] as const;

export type ConversionEvent = (typeof CONVERSION_EVENTS)[number];

/** Aggregates expire after 7 days — same window as client error reports. */
export const CONVERSION_TTL_MS = 7 * 24 * 3600 * 1000;

export const CONVERSION_STATS_DAY_COUNT = 7;

export function isConversionEvent(v: unknown): v is ConversionEvent {
  return typeof v === "string" && (CONVERSION_EVENTS as readonly string[]).includes(v);
}

function metricKey(date: string, event: ConversionEvent): string {
  return `metrics:daily:${date}:${event}`;
}

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Increment the daily counter for an allowlisted event. Returns false for
 * non-allowlisted events (dropped silently). Never throws — telemetry
 * failure must never affect the paid-action UX.
 */
export async function recordConversion(
  store: KvStore,
  eventRaw: unknown,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!isConversionEvent(eventRaw)) return false;
  try {
    await store.incr(metricKey(utcDate(new Date(nowMs)), eventRaw), CONVERSION_TTL_MS);
    return true;
  } catch {
    return false;
  }
}

/** Daily totals per event for the last `days` days, newest first. */
export interface ConversionDayStats {
  date: string;
  events: Partial<Record<ConversionEvent, number>>;
}

export async function getConversionStats(
  store: KvStore,
  days: number = CONVERSION_STATS_DAY_COUNT,
  nowMs: number = Date.now(),
): Promise<ConversionDayStats[]> {
  const out: ConversionDayStats[] = [];
  for (let i = 0; i < days; i++) {
    const date = utcDate(new Date(nowMs - i * 86400_000));
    const events: Partial<Record<ConversionEvent, number>> = {};
    for (const event of CONVERSION_EVENTS) {
      try {
        const raw = await store.get(metricKey(date, event));
        const n = raw == null ? 0 : parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) events[event] = n;
      } catch {
        /* skip unreadable counters */
      }
    }
    out.push({ date, events });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Founder-gated admin readout (reuses the client-errors founder gate)  */
/* ------------------------------------------------------------------ */

export interface ConversionAdminDeps {
  store: KvStore;
  verifySession: (
    cred: unknown,
  ) => Promise<
    | { ok: true; address: string }
    | { ok: false; error: string }
  >;
  env?: Record<string, string | undefined>;
}

export interface AdminMetricsResult {
  status: number;
  json: unknown;
}

export async function getConversionStatsAdmin(
  deps: ConversionAdminDeps,
  cred: unknown,
): Promise<AdminMetricsResult> {
  if (cred == null) {
    return { status: 401, json: { error: "sign in with your wallet to view metrics" } };
  }
  const verified = await deps.verifySession(cred);
  if (!verified.ok) return { status: 401, json: { error: verified.error } };
  if (!isFounderWallet(verified.address, deps.env ?? process.env)) {
    return { status: 403, json: { error: "metrics are private — founders only" } };
  }
  try {
    const days = await getConversionStats(deps.store);
    return { status: 200, json: { days, dayCount: CONVERSION_STATS_DAY_COUNT } };
  } catch {
    return { status: 503, json: { error: "could not read metrics — try again in a moment" } };
  }
}

/** Production wiring: real store + session auth port. */
export function defaultConversionAdminDeps(): ConversionAdminDeps {
  return {
    store: getKvStore(),
    verifySession: async (cred: unknown) => {
      const { defaultAuthPort } = await import("./townhall/auth");
      const res = await defaultAuthPort().verifySession(cred);
      return res.ok ? { ok: true as const, address: res.session.address } : { ok: false as const, error: res.error };
    },
  };
}
