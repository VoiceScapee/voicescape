/**
 * Widget open-link delivery diagnostics (yuigui's suggestion, 2026-10-04).
 *
 * Problem: a widget button that fires `ui/open-link` can silently die —
 * a spec-compliant host ignores unknown/mishandled methods with no error,
 * so every button becomes a picture of a button and nobody knows.
 *
 * Fix: correlate issuance with visits. Each `render_blockpage` call mints
 * a random widget-instance id (`wid`). The widget appends it to every
 * open-link URL. When the user's browser lands on the page, the page
 * beacons `/api/widget-visit`. A `wid` that was issued but never visited
 * is a cheap tell that the host dropped the open-link (or the user never
 * clicked — the signal is directional, not definitive).
 *
 * Privacy: `wid` is random (no PII, no IP, no wallet). Only aggregate
 * issued/visited flags are stored, 7-day TTL, same rules as the MCP
 * error telemetry. Best-effort: logging never throws and never changes
 * what the agent or user receives.
 */
import { randomBytes } from "crypto";
import { getKvStore, type KvStore } from "./store";

const WID_PREFIX = "widget:wid:";
const WID_TTL_MS = 7 * 24 * 3_600_000; // 7 days, like the other telemetry
const WID_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // unambiguous, like claim codes
const WID_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const ISSUED_SUFFIX = ":issued";
const VISITED_SUFFIX = ":visited";
const STATS_ISSUED_KEY = "widget:stats:issued";
const STATS_VISITED_KEY = "widget:stats:visited";

/** Mint a random 8-char widget instance id. */
export function mintWidgetId(): string {
  const bytes = randomBytes(8);
  let s = "";
  for (const b of bytes) s += WID_CHARS[b % WID_CHARS.length];
  return s;
}

/** True if the string looks like a minted widget id (format check only). */
export function isWidgetId(raw: unknown): raw is string {
  return typeof raw === "string" && WID_RE.test(raw);
}

/** Record that a widget instance was issued (render_blockpage called). */
export async function logWidgetIssued(
  wid: string,
  store: KvStore = getKvStore(),
): Promise<void> {
  if (!isWidgetId(wid)) return;
  try {
    await store.set(`${WID_PREFIX}${wid}${ISSUED_SUFFIX}`, "1", WID_TTL_MS);
    await bumpCounter(store, STATS_ISSUED_KEY);
  } catch {
    /* best-effort */
  }
}

/** Record that a browser visited a page carrying this widget id. */
export async function logWidgetVisit(
  wid: string,
  store: KvStore = getKvStore(),
): Promise<void> {
  if (!isWidgetId(wid)) return;
  try {
    await store.set(`${WID_PREFIX}${wid}${VISITED_SUFFIX}`, "1", WID_TTL_MS);
    await bumpCounter(store, STATS_VISITED_KEY);
  } catch {
    /* best-effort */
  }
}

/** Best-effort counter bump (get-parse-set; races are fine for telemetry). */
async function bumpCounter(store: KvStore, key: string): Promise<void> {
  try {
    const raw = await store.get(key);
    const n = raw ? parseInt(raw, 10) : 0;
    await store.set(key, String((Number.isFinite(n) ? n : 0) + 1), WID_TTL_MS);
  } catch {
    /* best-effort */
  }
}

/** Aggregate issuance/visit counts — the "cheap tell" dashboard. */
export async function getWidgetStats(
  store: KvStore = getKvStore(),
): Promise<{ issued: number; visited: number }> {
  try {
    const [i, v] = await Promise.all([
      store.get(STATS_ISSUED_KEY),
      store.get(STATS_VISITED_KEY),
    ]);
    const issued = i ? parseInt(i, 10) : 0;
    const visited = v ? parseInt(v, 10) : 0;
    return {
      issued: Number.isFinite(issued) ? issued : 0,
      visited: Number.isFinite(visited) ? visited : 0,
    };
  } catch {
    return { issued: 0, visited: 0 };
  }
}

/** True if this widget id was issued (guards the visit beacon). */
export async function wasWidgetIssued(
  wid: string,
  store: KvStore = getKvStore(),
): Promise<boolean> {
  if (!isWidgetId(wid)) return false;
  try {
    return (await store.get(`${WID_PREFIX}${wid}${ISSUED_SUFFIX}`)) !== null;
  } catch {
    return false;
  }
}

export interface WidgetDiagnostics {
  /** Total issued in the window. */
  issued: number;
  /** Total visited in the window. */
  visited: number;
}
