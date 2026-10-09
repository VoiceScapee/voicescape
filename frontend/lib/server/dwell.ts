/**
 * Anonymous dwell-time instrumentation for the tip flow.
 *
 * Separates human dwell time from machine latency:
 *   T0  registration confirmed ......... on-chain (consensus timestamp)
 *   T1  user opens the tip flow ........ server-observed (this module)
 *   T2  user signs the transaction ..... server-observed (this module)
 *   T3  tip confirmed on-chain ......... mirror-node consensus timestamp
 *
 * Human dwell  = T2 - T1.  Machine latency = T3 - T2.
 *
 * PRIVACY MODEL — read this before touching anything:
 *   A tip flow is keyed by a server-generated random flow id. The stored
 *   record holds bare timestamps, a challenge nonce, a coarse surface
 *   label, and an optional client-generated cohort key. NEVER stored:
 *   wallet addresses, IPs, user agents, page URLs, usernames, tx ids.
 *   The cohort key is a random UUID the browser generates once and keeps
 *   in localStorage — it groups repeat flows for stability analysis and
 *   is never joined with identity. Clearing site data rotates it. The
 *   client may omit it; the flow still works, just ungrouped.
 *   Records expire after 7 days, same as conversion telemetry.
 *
 * Telemetry always fails open: recording never throws and never affects
 * the paid action it measures. Settlement logic, fee math, and the 98/2
 * split are untouched — this module only observes.
 */

import type { KvStore } from "./store";
import { getKvStore } from "./store";
import { isConversionContext, type ConversionContext } from "./conversion";
import { isFounderWallet } from "./client-errors";

/** Per-flow records expire after 7 days — same window as conversion. */
export const DWELL_TTL_MS = 7 * 24 * 3600 * 1000;

/** Allowable clock skew when validating T3 (mirror-node lag, device drift). */
export const DWELL_FUTURE_SKEW_MS = 60_000;

const FLOW_KEY_PREFIX = "dwell:flow:";
const FLOW_ID_RE = /^dfl_[0-9a-f]{16}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
/** Cohort: client-generated random grouping key (UUID v4 shape). */
const COHORT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DwellViolation =
  | "t2_before_t1"
  | "t3_before_t2"
  | "dwell_exceeds_total"
  | "t3_in_future"
  | "negative_dwell";

export interface DwellFlow {
  t1: number;
  t2: number | null;
  t3: number | null;
  nonce: string;
  context: ConversionContext | null;
  cohort: string | null;
  flags: DwellViolation[];
}

export interface DwellValidation {
  ok: boolean;
  violations: DwellViolation[];
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isFlowId(v: unknown): v is string {
  return typeof v === "string" && FLOW_ID_RE.test(v);
}

export function isNonce(v: unknown): v is string {
  return typeof v === "string" && NONCE_RE.test(v);
}

function isCohort(v: unknown): v is string {
  return typeof v === "string" && COHORT_RE.test(v);
}

function flowKey(flowId: string): string {
  return `${FLOW_KEY_PREFIX}${flowId}`;
}

/**
 * Pure validation for a completed flow's timestamps.
 *   - t1 <= t2 <= t3 (monotonicity)
 *   - (t2 - t1) <= (t3 - t1) (dwell cannot exceed the total window)
 *   - t3 not in the future beyond skew allowance
 *   - no negative durations
 * Violations are flagged, never silently ingested.
 */
export function validateDwellFlow(
  t1: number,
  t2: number,
  t3: number,
  nowMs: number = Date.now(),
): DwellValidation {
  const violations: DwellViolation[] = [];
  if (!Number.isFinite(t1) || !Number.isFinite(t2) || !Number.isFinite(t3)) {
    return { ok: false, violations: ["negative_dwell"] };
  }
  if (t2 < t1) violations.push("t2_before_t1");
  if (t3 < t2) violations.push("t3_before_t2");
  if (t2 - t1 > t3 - t1) violations.push("dwell_exceeds_total");
  if (t3 - t1 < 0) violations.push("negative_dwell");
  if (t3 > nowMs + DWELL_FUTURE_SKEW_MS) violations.push("t3_in_future");
  return { ok: violations.length === 0, violations };
}

/** Histogram buckets for human dwell (T2 - T1), in milliseconds. */
export type DwellBucket = "lt_5s" | "5s_30s" | "30s_2m" | "2m_10m" | "gt_10m";

export function dwellBucket(dwellMs: number): DwellBucket {
  if (dwellMs < 5_000) return "lt_5s";
  if (dwellMs < 30_000) return "5s_30s";
  if (dwellMs < 120_000) return "30s_2m";
  if (dwellMs < 600_000) return "2m_10m";
  return "gt_10m";
}

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function readFlow(store: KvStore, flowId: string): Promise<DwellFlow | null> {
  try {
    const raw = await store.get(flowKey(flowId));
    if (!raw) return null;
    const f = JSON.parse(raw) as DwellFlow;
    if (typeof f.t1 !== "number" || typeof f.nonce !== "string") return null;
    return f;
  } catch {
    return null;
  }
}

async function writeFlow(store: KvStore, flowId: string, flow: DwellFlow): Promise<boolean> {
  try {
    await store.set(flowKey(flowId), JSON.stringify(flow), DWELL_TTL_MS);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a dwell flow. T1 is stamped on the SERVER clock at receipt —
 * never client-asserted. Returns the flow id and a challenge nonce the
 * client must present at sign and settlement (binds the three events,
 * kills lazy-receipt attacks). Returns null on invalid input or store
 * failure (telemetry fails open).
 */
export async function openDwellFlow(
  store: KvStore,
  opts?: { context?: unknown; cohort?: unknown; nowMs?: number },
): Promise<{ flowId: string; nonce: string } | null> {
  const nowMs = opts?.nowMs ?? Date.now();
  const context = isConversionContext(opts?.context) ? opts.context : null;
  const cohort = isCohort(opts?.cohort) ? (opts.cohort as string).toLowerCase() : null;
  const flowId = `dfl_${randomHex(8)}`;
  const nonce = randomHex(16);
  const flow: DwellFlow = { t1: nowMs, t2: null, t3: null, nonce, context, cohort, flags: [] };
  const ok = await writeFlow(store, flowId, flow);
  return ok ? { flowId, nonce } : null;
}

/**
 * Record the signature submission. T2 is stamped on the SERVER clock.
 * The nonce must match the one issued at open; a flow can only be
 * signed once (replay protection). Returns false for unknown flows,
 * nonce mismatches, or double-signs — all dropped silently.
 */
export async function recordDwellSign(
  store: KvStore,
  flowIdRaw: unknown,
  nonceRaw: unknown,
  opts?: { nowMs?: number },
): Promise<boolean> {
  if (!isFlowId(flowIdRaw) || !isNonce(nonceRaw)) return false;
  const flow = await readFlow(store, flowIdRaw);
  if (!flow || flow.nonce !== nonceRaw || flow.t2 !== null) return false;
  flow.t2 = opts?.nowMs ?? Date.now();
  return writeFlow(store, flowIdRaw, flow);
}

export interface DwellSettledResult {
  ok: boolean;
  violations: DwellViolation[];
  /** Human dwell (T2 - T1) in ms, when computable. */
  dwellMs: number | null;
  /** Machine latency (T3 - T2) in ms, when computable. */
  machineMs: number | null;
}

/**
 * Record on-chain settlement. t3Ms is the mirror-node consensus timestamp
 * in epoch ms (client converts; the value is cross-checked by validation).
 * Runs monotonicity + bounds checks, files violations into aggregate
 * counters (never silently ingested), and buckets the dwell histogram.
 */
export async function recordDwellSettled(
  store: KvStore,
  flowIdRaw: unknown,
  nonceRaw: unknown,
  t3MsRaw: unknown,
  opts?: { nowMs?: number },
): Promise<DwellSettledResult> {
  const fail: DwellSettledResult = { ok: false, violations: [], dwellMs: null, machineMs: null };
  if (!isFlowId(flowIdRaw) || !isNonce(nonceRaw)) return fail;
  const t3 = typeof t3MsRaw === "number" ? t3MsRaw : NaN;
  if (!Number.isFinite(t3) || t3 <= 0) return fail;
  const flow = await readFlow(store, flowIdRaw);
  if (!flow || flow.nonce !== nonceRaw) return fail;
  const nowMs = opts?.nowMs ?? Date.now();
  flow.t3 = t3;

  const t2 = flow.t2;
  let result: DwellSettledResult = { ...fail, ok: true };
  if (t2 === null) {
    // Settled without an observed sign — the sign event was missed or
    // never fired. Still record T3; flag it rather than dropping.
    flow.flags.push("t3_before_t2");
    result = { ...result, violations: ["t3_before_t2"] };
  } else {
    const v = validateDwellFlow(flow.t1, t2, t3, nowMs);
    result = {
      ok: v.ok,
      violations: v.violations,
      dwellMs: t2 - flow.t1,
      machineMs: t3 - t2,
    };
    flow.flags.push(...v.violations);
    if (v.ok && result.dwellMs !== null) {
      const bucket = dwellBucket(result.dwellMs);
      const date = utcDate(new Date(nowMs));
      try {
        await store.incr(`metrics:daily:${date}:dwell:${bucket}`, DWELL_TTL_MS);
        await store.incr(`metrics:daily:${date}:dwell_completed`, DWELL_TTL_MS);
        if (flow.cohort) {
          await store.incr(`metrics:daily:${date}:dwell_cohort_flows`, DWELL_TTL_MS);
        }
      } catch {
        /* aggregate counters are best-effort */
      }
    }
  }
  if (result.violations.length > 0) {
    const date = utcDate(new Date(nowMs));
    for (const vtype of new Set(result.violations)) {
      try {
        await store.incr(`metrics:daily:${date}:dwell_violation:${vtype}`, DWELL_TTL_MS);
      } catch {
        /* best-effort */
      }
    }
  }
  await writeFlow(store, flowIdRaw, flow);
  return result;
}

/** Aggregate dwell stats for admin readout: buckets, violations, completions. */
export interface DwellDayStats {
  date: string;
  completed: number;
  buckets: Partial<Record<DwellBucket, number>>;
  violations: Partial<Record<DwellViolation, number>>;
  cohortFlows: number;
  /**
   * Tail mass: count of completed flows in the lt_5s bucket — the honest
   * upper bound on "decided before landing". Pre-arrival decision is
   * invisible: a flow the human decided before T1 compresses the T1→T2
   * interval exactly like fast conviction, and no client clock can split
   * them. So we publish the bound — the mass of the short-dwell tail —
   * rather than pretending to separate the two. Dwell bounds the visible
   * interval (T1→T2, server-observed); the tail mass bounds the invisible
   * one (everything before T1). Neither touches a client clock.
   */
  tailMass: number;
  /** tailMass / completed, when completed > 0. */
  tailMassFraction: number | null;
}

const DWELL_BUCKETS: DwellBucket[] = ["lt_5s", "5s_30s", "30s_2m", "2m_10m", "gt_10m"];
const DWELL_VIOLATIONS: DwellViolation[] = [
  "t2_before_t1",
  "t3_before_t2",
  "dwell_exceeds_total",
  "t3_in_future",
  "negative_dwell",
];

export async function getDwellStats(
  store: KvStore,
  days: number = 7,
  nowMs: number = Date.now(),
): Promise<DwellDayStats[]> {
  const out: DwellDayStats[] = [];
  for (let i = 0; i < days; i++) {
    const date = utcDate(new Date(nowMs - i * 86400_000));
    const day: DwellDayStats = {
      date,
      completed: 0,
      buckets: {},
      violations: {},
      cohortFlows: 0,
      tailMass: 0,
      tailMassFraction: null,
    };
    const num = async (key: string): Promise<number> => {
      try {
        const raw = await store.get(key);
        const n = raw == null ? 0 : parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? n : 0;
      } catch {
        return 0;
      }
    };
    day.completed = await num(`metrics:daily:${date}:dwell_completed`);
    day.cohortFlows = await num(`metrics:daily:${date}:dwell_cohort_flows`);
    for (const b of DWELL_BUCKETS) {
      const n = await num(`metrics:daily:${date}:dwell:${b}`);
      if (n > 0) day.buckets[b] = n;
    }
    for (const v of DWELL_VIOLATIONS) {
      const n = await num(`metrics:daily:${date}:dwell_violation:${v}`);
      if (n > 0) day.violations[v] = n;
    }
    // Tail mass = the short-dwell tail's mass: upper bound on
    // "decided before landing" (see DwellDayStats.tailMass).
    day.tailMass = day.buckets["lt_5s"] ?? 0;
    if (day.completed > 0) day.tailMassFraction = day.tailMass / day.completed;
    out.push(day);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Founder-gated admin readout (same gate as conversion metrics)      */
/* ------------------------------------------------------------------ */

export interface DwellAdminDeps {
  store: KvStore;
  verifySession: (
    cred: unknown,
  ) => Promise<
    | { ok: true; address: string }
    | { ok: false; error: string }
  >;
  env?: Record<string, string | undefined>;
}

export interface DwellAdminResult {
  status: number;
  json: unknown;
}

export async function getDwellStatsAdmin(
  deps: DwellAdminDeps,
  cred: unknown,
  nowMs: number = Date.now(),
): Promise<DwellAdminResult> {
  if (cred == null) {
    return { status: 401, json: { error: "sign in with your wallet to view metrics" } };
  }
  const verified = await deps.verifySession(cred);
  if (!verified.ok) return { status: 401, json: { error: verified.error } };
  if (!isFounderWallet(verified.address, deps.env ?? process.env)) {
    return { status: 403, json: { error: "metrics are private — founders only" } };
  }
  try {
    const days = await getDwellStats(deps.store, 7, nowMs);
    return { status: 200, json: { days, dayCount: 7 } };
  } catch {
    return { status: 503, json: { error: "could not read metrics — try again in a moment" } };
  }
}

/** Production wiring: real store + session auth port. */
export function defaultDwellAdminDeps(): DwellAdminDeps {
  return {
    store: getKvStore(),
    verifySession: async (cred: unknown) => {
      const { defaultAuthPort } = await import("./townhall/auth");
      const res = await defaultAuthPort().verifySession(cred);
      return res.ok ? { ok: true as const, address: res.session.address } : { ok: false as const, error: res.error };
    },
  };
}
