/**
 * Blockchain Heartbeat — server-side mirror-node reads (Hedera mainnet only).
 *
 * The client NEVER hits the mirror node directly. This module backs
 * GET /api/heartbeat?wallet=<0.0.x|0x…>: it reads the Tips contract's
 * TipSent event logs, filters them to the page owner's wallet, and returns
 * the settled tip events since the last check. Read-only public data —
 * no keys, no HBAR movement.
 *
 * Cursor discipline (known production bug, see AGENTS.md): consensus
 * timestamps are EXACT STRINGS. Never parseFloat them — float rounding
 * re-fetches the same trailing log forever. The cursor is always the raw
 * `timestamp` string from the last log seen.
 *
 * Same-timestamp logs (several logs can share one consensus timestamp)
 * make `timestamp=gt:` SKIP logs, so we poll with `gte:` and dedupe by
 * event id instead. Dedupe is per server instance (best-effort) AND per
 * client (authoritative) — serverless instances don't share memory.
 */

import { decodeTipSentLog } from "../leaderboard";
import { canonicalAddress } from "../session-message";

const MIRROR_NODE = "https://mainnet.mirrornode.hedera.com/api/v1";
const TIPS_CONTRACT = "0.0.10854060";
/** Server-side cache: one mirror read serves every viewer poll for ~10s. */
const CACHE_TTL_MS = 10_000;
/** A stale cache may still serve a degraded answer for this long. */
const STALE_CACHE_MAX_MS = 120_000;
/** Mirror fetch timeout — slower than this is "mirror slow", not offline. */
const MIRROR_TIMEOUT_MS = 8_000;
/** Above this round-trip the check counts as degraded ("syncing · mirror slow"). */
const SLOW_THRESHOLD_MS = 6_000;
/** Cap on remembered event ids per wallet (insertion-ordered, oldest dropped). */
const SEEN_IDS_CAP = 500;

export interface HeartbeatEvent {
  /** Dedupe key: mirror transaction hash, or "timestamp:log_index" fallback. */
  id: string;
  type: "tip";
  /** Creator's net 98% share, in HBAR (the only figure UIs may display). */
  amountHbar: number;
  /** Net tinybar as a string (exact, no float). */
  amountTinybar: string;
  /** Consensus timestamp, exact string — the pagination cursor. */
  ts: string;
  /** HashScan link target for the settled transaction. */
  txHash: string | null;
}

export type HeartbeatStatus = "ok" | "degraded" | "offline";

export interface HeartbeatResult {
  ok: boolean;
  status: HeartbeatStatus;
  /** Canonical lowercase EVM address of the page owner. */
  wallet: string;
  /** Exact-string cursor of the newest log scanned (for transparency). */
  cursor: string | null;
  checkedAt: number;
  cached: boolean;
  /** True when the mirror answered but slowly — the "mirror slow" state. */
  slow: boolean;
  events: HeartbeatEvent[];
  error?: string;
}

interface WalletState {
  at: number;
  lastTs: string | null;
  seenIds: string[];
  seenSet: Set<string>;
  lastResult: HeartbeatResult;
}

const walletStates = new Map<string, WalletState>();

function getState(wallet: string): WalletState {
  let s = walletStates.get(wallet);
  if (!s) {
    s = { at: 0, lastTs: null, seenIds: [], seenSet: new Set(), lastResult: null as unknown as HeartbeatResult };
    walletStates.set(wallet, s);
  }
  return s;
}

/** For tests: reset module state. */
export function __resetHeartbeatState(): void {
  walletStates.clear();
}

interface MirrorLog {
  timestamp?: unknown;
  data?: unknown;
  topics?: unknown;
  transaction_hash?: unknown;
  log_index?: unknown;
}

function eventId(log: MirrorLog): string {
  const txHash = typeof log.transaction_hash === "string" ? log.transaction_hash : "";
  const ts = typeof log.timestamp === "string" ? log.timestamp : "";
  const idx = typeof log.log_index === "number" ? log.log_index : 0;
  return txHash || `${ts}:${idx}`;
}

async function fetchJson(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; json: unknown; ms: number }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, status: res.status, json: null, ms };
    return { ok: true, status: res.status, json: await res.json(), ms };
  } catch {
    return { ok: false, status: 0, json: null, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the page owner's settled tip events from the mirror node.
 * Never throws — transport failures surface as degraded/offline results.
 */
export async function fetchHeartbeat(wallet: string): Promise<HeartbeatResult> {
  const canonical = canonicalAddress(wallet);
  if (!canonical) {
    return {
      ok: false,
      status: "offline",
      wallet: "",
      cursor: null,
      checkedAt: Date.now(),
      cached: false,
      slow: false,
      events: [],
      error: "bad-wallet",
    };
  }
  const state = getState(canonical);
  const now = Date.now();

  // Fresh cache: serve it, no mirror hit.
  if (now - state.at < CACHE_TTL_MS && state.lastResult) {
    return { ...state.lastResult, checkedAt: now, cached: true };
  }

  // NOTE: mirror-node topic query filters SILENTLY MATCH NOTHING on
  // /contracts/{id}/results/logs (verified 2026-09-13, see
  // lib/server/earnings.ts). Fetch unfiltered (bounded) and filter by
  // topic0 + recipient in code — decodeTipSentLog rejects non-TipSent
  // logs, and we match decoded.to against the page owner below.
  //
  // Cold start: fetch the NEWEST page (desc) and adopt its newest
  // timestamp as the cursor, emitting nothing — history is context, not
  // news, so a fresh server never spikes for old tips. Steady state
  // pages forward from the exact-string cursor (gte: + id dedupe, so
  // same-timestamp logs are never skipped).
  const isColdStart = state.lastTs === null;
  const url = isColdStart
    ? `${MIRROR_NODE}/contracts/${TIPS_CONTRACT}/results/logs?order=desc&limit=25`
    : `${MIRROR_NODE}/contracts/${TIPS_CONTRACT}/results/logs` +
      `?timestamp=gte:${encodeURIComponent(state.lastTs as string)}` +
      `&order=asc&limit=25`;

  const fetched = await fetchJson(url, MIRROR_TIMEOUT_MS);
  const slow = fetched.ms > SLOW_THRESHOLD_MS;

  if (!fetched.ok) {
    // Mirror unreachable: a recent cache still answers, honestly degraded.
    if (state.lastResult && now - state.at < STALE_CACHE_MAX_MS) {
      return {
        ...state.lastResult,
        status: "degraded",
        checkedAt: now,
        cached: true,
        slow: false,
        error: "mirror-unreachable",
      };
    }
    const result: HeartbeatResult = {
      ok: true,
      status: "offline",
      wallet: canonical,
      cursor: state.lastTs,
      checkedAt: now,
      cached: false,
      slow: false,
      events: [],
      error: "mirror-unreachable",
    };
    state.at = now;
    state.lastResult = result;
    return result;
  }

  const logs = (fetched.json as { logs?: unknown })?.logs;
  const logList: MirrorLog[] = Array.isArray(logs) ? (logs as MirrorLog[]) : [];
  const events: HeartbeatEvent[] = [];
  let newestTs = state.lastTs;

  for (const log of logList) {
    const ts = typeof log.timestamp === "string" ? log.timestamp : null;
    if (ts && (!newestTs || ts > newestTs)) newestTs = ts;
    const id = eventId(log);
    if (state.seenSet.has(id)) continue;
    const decoded = decodeTipSentLog(log);
    // Not a well-formed TipSent, or not for this page owner — advance the
    // cursor past it but emit nothing.
    if (!decoded || decoded.to !== canonical) continue;
    state.seenSet.add(id);
    state.seenIds.push(id);
    const txHash = typeof log.transaction_hash === "string" ? log.transaction_hash : null;
    events.push({
      id,
      type: "tip",
      amountHbar: decoded.amountHbar,
      // Recompute exact tinybar from the log data (no float round-trip).
      amountTinybar: netTinybarOf(log),
      ts: decoded.timestamp,
      txHash,
    });
  }
  // Bound the seen set (insertion-ordered; oldest evicted first).
  while (state.seenIds.length > SEEN_IDS_CAP) {
    const dropped = state.seenIds.shift();
    if (dropped) state.seenSet.delete(dropped);
  }
  state.lastTs = newestTs;

  // Cold start: history is context, not news. The baseline page's events
  // are marked seen above; emit nothing so a fresh server never spikes
  // for old tips. The client additionally suppresses first-poll spikes
  // as defense in depth.
  const emitted = isColdStart ? [] : events;

  const result: HeartbeatResult = {
    ok: true,
    status: slow ? "degraded" : "ok",
    wallet: canonical,
    cursor: newestTs,
    checkedAt: now,
    cached: false,
    slow,
    events: emitted,
  };
  state.at = now;
  state.lastResult = result;
  return result;
}

/**
 * Exact net tinybar (gross − fee) from the TipSent log data words.
 * decodeTipSentLog returns a float HBAR figure for display; the heartbeat
 * keeps the exact string for spike scaling without float error.
 */
function netTinybarOf(log: MirrorLog): string {
  try {
    const data = typeof log.data === "string" ? log.data : "";
    if (data.length < 130) return "0";
    const gross = BigInt("0x" + data.slice(2, 66));
    const fee = BigInt("0x" + data.slice(66, 130));
    if (fee < 0n || fee > gross) return "0";
    return (gross - fee).toString();
  } catch {
    return "0";
  }
}
