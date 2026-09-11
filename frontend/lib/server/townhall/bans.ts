/**
 * Voicescape Social Town Hall — graduated enforcement.
 *
 * A ladder, not an on/off switch:
 *   warn → timeout → temp ban → permanent ban
 *
 * Warnings are logged notices with no restriction. Timeouts suspend writes
 * for minutes/hours and auto-expire. Temp bans suspend until their
 * expiresAt. Permanent bans are indefinite. Unbans and appeal resolutions
 * ("lifted") clear restrictions early; everything is latest-wins per
 * wallet so the record stays auditable on HCS.
 *
 * All records live on the FORUM topic — one canonical location checkable
 * from every write path. Enforcement keys on the canonical wallet address
 * (0x lowercase), never on usernames.
 *
 * Enforcement reads go through deps.hcs.queryAll(forum topic), which the
 * CachedHcsClient serves from a 30s cache — the write-path check is a
 * cache read plus an in-memory scan (<10ms after the first hit).
 * Submitting any enforcement record invalidates the forum topic cache, so
 * a fresh timeout/ban takes effect on the very next write.
 */

import { canonicalAddress } from "../../session-message";
import { getTopicId } from "./topics";
import type { HcsPort } from "./hcs";
import type {
  AppealMessage,
  AppealResolveMessage,
  AppealView,
  BanMessage,
  BanView,
  EnforcementStateSummary,
  EnforcementSuggestion,
  StoredMessage,
  TimeoutMessage,
  TimeoutView,
  UnbanMessage,
  WarnMessage,
  WarnView,
} from "./types";

/** Records that change a wallet's enforcement state. */
export type EnforcementEvent =
  | WarnMessage
  | TimeoutMessage
  | BanMessage
  | UnbanMessage
  | AppealResolveMessage;

export type EnforcementStatus = "clean" | "warned" | "timed-out" | "temp-banned" | "banned";

export interface EnforcementState extends EnforcementStateSummary {
  /** The record that produced this state; null when clean. */
  kind: "warn" | "timeout" | "ban" | null;
}

export type ViolationSeverity = "low" | "medium" | "high" | "critical";

/** Max timeout length: 30 days in minutes. Longer → use a temp ban. */
export const MAX_TIMEOUT_MINUTES = 30 * 24 * 60;

/**
 * Pull enforcement + appeal records out of a message list. Pure.
 */
export function collectEnforcementEvents(messages: StoredMessage[]): EnforcementEvent[] {
  const out: EnforcementEvent[] = [];
  for (const m of messages) {
    const k = m.contents.kind;
    if (k === "warn" || k === "timeout" || k === "ban" || k === "unban" || k === "appeal-resolve") {
      out.push(m.contents as EnforcementEvent);
    }
  }
  return out;
}

/** Pull appeal records out of a message list. Pure. */
export function collectAppealEvents(messages: StoredMessage[]): AppealMessage[] {
  const out: AppealMessage[] = [];
  for (const m of messages) {
    if (m.contents.kind === "appeal") out.push(m.contents as AppealMessage);
  }
  return out;
}

function walletOf(e: EnforcementEvent | AppealMessage): string | null {
  return canonicalAddress(e.wallet);
}

/**
 * Prior offenses on record: count of warn/timeout/ban records for the
 * wallet. Drives the escalation ladder in suggestEnforcement. Pure.
 */
export function countOffenses(wallet: string, events: EnforcementEvent[]): number {
  const c = canonicalAddress(wallet);
  if (!c) return 0;
  let n = 0;
  for (const e of events) {
    if (walletOf(e) !== c) continue;
    if (e.kind === "warn" || e.kind === "timeout" || e.kind === "ban") n += 1;
  }
  return n;
}

/**
 * The wallet's current effective enforcement state. Latest-wins per
 * wallet across warn/timeout/ban/unban/appeal-resolve records; timeouts
 * and temp bans auto-expire. Pure — unit-testable.
 */
export function getEnforcementState(
  wallet: string,
  events: EnforcementEvent[],
  nowMs: number = Date.now(),
): EnforcementState {
  const c = canonicalAddress(wallet);
  const clean: EnforcementState = { status: "clean", reason: null, remainingMs: null, expiresAt: null, kind: null };
  if (!c) return clean;
  const mine = events
    .filter((e) => walletOf(e) === c)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  // Walk newest → oldest; an "upheld" appeal falls through to the record
  // it upheld, everything else decides immediately.
  for (let i = mine.length - 1; i >= 0; i--) {
    const e = mine[i];
    switch (e.kind) {
      case "unban":
        return clean;
      case "appeal-resolve":
        if (e.action === "lifted") return clean;
        continue; // upheld: the prior enforcement stands
      case "warn":
        return { status: "warned", reason: e.reason, remainingMs: null, expiresAt: null, kind: "warn" };
      case "timeout":
        if (e.expiresAt <= nowMs) return clean;
        return {
          status: "timed-out",
          reason: e.reason,
          remainingMs: e.expiresAt - nowMs,
          expiresAt: e.expiresAt,
          kind: "timeout",
        };
      case "ban":
        if (e.expiresAt !== null && e.expiresAt <= nowMs) return clean;
        return {
          status: e.expiresAt === null ? "banned" : "temp-banned",
          reason: e.reason,
          remainingMs: e.expiresAt === null ? null : e.expiresAt - nowMs,
          expiresAt: e.expiresAt,
          kind: "ban",
        };
    }
  }
  return clean;
}

/**
 * True when the wallet currently cannot write (timed out, temp-banned, or
 * permanently banned). Warnings don't restrict. Pure.
 */
export function isRestricted(wallet: string, events: EnforcementEvent[], nowMs: number = Date.now()): boolean {
  const s = getEnforcementState(wallet, events, nowMs).status;
  return s === "timed-out" || s === "temp-banned" || s === "banned";
}

/** Back-compat alias: bans block writes, and so do timeouts. */
export const isBanned = isRestricted;

/** "42m", "3h", "5d" — for 403 messages. */
export function formatRemaining(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Recommend the next enforcement step from the wallet's history and the
 * severity of the current violation. Repeat offenses escalate; critical
 * violations (CSAM, credible threats) jump straight to permanent ban.
 * Pure — the mod still makes the call.
 */
export function suggestEnforcement(
  wallet: string,
  severity: ViolationSeverity,
  events: EnforcementEvent[],
): EnforcementSuggestion {
  const offenseCount = countOffenses(wallet, events);
  if (severity === "critical") {
    return {
      recommended: "permanent-ban",
      durationMinutes: null,
      offenseCount,
      note: "critical violation (e.g. CSAM, credible violent threat): permanent ban regardless of history",
    };
  }
  if (severity === "high") {
    if (offenseCount === 0) {
      return {
        recommended: "temp-ban",
        durationMinutes: 30 * 24 * 60,
        offenseCount,
        note: "high severity, first offense: 30-day temp ban",
      };
    }
    return {
      recommended: "permanent-ban",
      durationMinutes: null,
      offenseCount,
      note: "high severity repeat offense: permanent ban",
    };
  }
  if (severity === "medium") {
    if (offenseCount === 0) {
      return { recommended: "timeout", durationMinutes: 60, offenseCount, note: "medium severity, first offense: 1-hour timeout" };
    }
    if (offenseCount === 1) {
      return {
        recommended: "temp-ban",
        durationMinutes: 7 * 24 * 60,
        offenseCount,
        note: "medium severity, second offense: 7-day temp ban",
      };
    }
    return { recommended: "permanent-ban", durationMinutes: null, offenseCount, note: "medium severity, repeat offense: permanent ban" };
  }
  // low
  if (offenseCount === 0) {
    return { recommended: "warn", durationMinutes: null, offenseCount, note: "low severity, first offense: formal warning" };
  }
  if (offenseCount === 1) {
    return { recommended: "timeout", durationMinutes: 15, offenseCount, note: "low severity, second offense: 15-minute timeout" };
  }
  if (offenseCount === 2) {
    return {
      recommended: "temp-ban",
      durationMinutes: 7 * 24 * 60,
      offenseCount,
      note: "low severity, third offense: 7-day temp ban",
    };
  }
  return { recommended: "permanent-ban", durationMinutes: null, offenseCount, note: "low severity, fourth+ offense: permanent ban" };
}

/* ------------------------------------------------------------------ */
/* HCS-backed reads                                                   */
/* ------------------------------------------------------------------ */

type HcsOnly = { hcs: HcsPort };

async function readEnforcementEvents(deps: HcsOnly): Promise<EnforcementEvent[]> {
  const topic = getTopicId("forum");
  if (!topic) {
    console.warn("[townhall] enforcement: forum topic not configured — enforcement disabled");
    return [];
  }
  try {
    const messages = await deps.hcs.queryAll(topic);
    return collectEnforcementEvents(messages);
  } catch (e) {
    console.warn(`[townhall] enforcement: could not read records: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Latest enforcement event per wallet, newest-first input. On timestamp
 *  ties the later message in iteration order wins (queryAll returns
 *  seq-ordered, oldest first — so the higher-seq event is truly later). */
function latestPerWallet(events: EnforcementEvent[]): Map<string, EnforcementEvent> {
  const latest = new Map<string, EnforcementEvent>();
  for (const e of events) {
    const c = walletOf(e);
    if (!c) continue;
    const prev = latest.get(c);
    if (!prev || e.ts >= prev.ts) latest.set(c, e);
  }
  return latest;
}

/** All currently-active bans (temp + permanent), newest first. */
export async function getActiveBans(deps: HcsOnly, nowMs: number = Date.now()): Promise<BanView[]> {
  const events = await readEnforcementEvents(deps);
  const out: BanView[] = [];
  for (const [, e] of latestPerWallet(events)) {
    if (e.kind !== "ban") continue;
    if (e.expiresAt !== null && e.expiresAt <= nowMs) continue;
    const c = walletOf(e)!;
    out.push({ wallet: c, username: e.username, reason: e.reason, bannedBy: e.bannedBy, expiresAt: e.expiresAt, ts: e.ts });
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out;
}

/** All currently-active timeouts, newest first. */
export async function getActiveTimeouts(deps: HcsOnly, nowMs: number = Date.now()): Promise<TimeoutView[]> {
  const events = await readEnforcementEvents(deps);
  const out: TimeoutView[] = [];
  for (const [, e] of latestPerWallet(events)) {
    if (e.kind !== "timeout") continue;
    if (e.expiresAt <= nowMs) continue;
    const c = walletOf(e)!;
    out.push({
      wallet: c,
      username: e.username,
      reason: e.reason,
      timedOutBy: e.timedOutBy,
      durationMinutes: e.durationMinutes,
      expiresAt: e.expiresAt,
      ts: e.ts,
    });
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out;
}

/** All currently-active warnings (latest warn per wallet, not superseded by a later action), newest first. Warnings never expire. */
export async function getActiveWarnings(deps: HcsOnly): Promise<WarnView[]> {
  const events = await readEnforcementEvents(deps);
  const out: WarnView[] = [];
  for (const [, e] of latestPerWallet(events)) {
    if (e.kind !== "warn") continue;
    const c = walletOf(e)!;
    out.push({ wallet: c, username: e.username, reason: e.reason, warnedBy: e.warnedBy, ts: e.ts });
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out;
}

/** The wallet's current state, or clean when unreadable. */
export async function getStateFor(deps: HcsOnly, wallet: string, nowMs: number = Date.now()): Promise<EnforcementState> {
  const events = await readEnforcementEvents(deps);
  return getEnforcementState(wallet, events, nowMs);
}

/** Back-compat: the active ban for one wallet, or null. */
export async function getBanFor(deps: HcsOnly, wallet: string, nowMs: number = Date.now()): Promise<BanView | null> {
  const c = canonicalAddress(wallet);
  if (!c) return null;
  const bans = await getActiveBans(deps, nowMs);
  return bans.find((b) => b.wallet === c) ?? null;
}

export interface RestrictionCheck {
  status: number;
  json: { error: string };
}

/**
 * Write-path guard: timed-out and banned wallets cannot post, chat,
 * list, create rooms, or file reports. Runs BEFORE the dust-fee check so
 * restricted users are never charged. Returns null when clear, otherwise
 * the 403 result to return — same shape as the other guards
 * (safetyGate, requireDustFee).
 */
export async function requireNotRestricted(
  deps: HcsOnly,
  sessionAddress: string,
): Promise<RestrictionCheck | null> {
  const state = await getStateFor(deps, sessionAddress);
  if (state.status === "clean" || state.status === "warned") return null;
  const remaining = state.remainingMs !== null ? ` (${formatRemaining(state.remainingMs)} remaining)` : "";
  const what =
    state.status === "timed-out"
      ? "timed out"
      : state.status === "temp-banned"
        ? "temporarily banned"
        : "banned";
  console.warn(`[townhall] enforcement: blocked write from ${state.status} wallet — ${state.reason}`);
  return {
    status: 403,
    json: { error: `This wallet has been ${what}: ${state.reason}${remaining}` },
  };
}

/** Back-compat alias for the earlier on/off guard. */
export const requireNotBanned = requireNotRestricted;

/* ------------------------------------------------------------------ */
/* Appeals                                                            */
/* ------------------------------------------------------------------ */

/**
 * Appeals with no later resolution. An appeal is pending when no
 * "appeal-resolve" record for the wallet has a newer timestamp. Pure.
 */
export function pendingAppeals(
  appeals: AppealMessage[],
  resolutions: AppealResolveMessage[],
): AppealMessage[] {
  // A resolution always causally follows the appeal it resolves, so on a
  // same-millisecond timestamp tie the resolution still wins (>=).
  return appeals.filter((a) => {
    const c = canonicalAddress(a.wallet);
    if (!c) return false;
    return !resolutions.some((r) => canonicalAddress(r.wallet) === c && r.ts >= a.ts);
  });
}

/** One pending appeal per wallet — enforced at submit time. */
export function hasPendingAppeal(
  appeals: AppealMessage[],
  resolutions: AppealResolveMessage[],
  wallet: string,
): boolean {
  const c = canonicalAddress(wallet);
  if (!c) return false;
  return pendingAppeals(appeals, resolutions).some((a) => canonicalAddress(a.wallet) === c);
}

/** Mod appeal queue: pending appeals with the appellant's live restriction state. */
export async function getPendingAppeals(deps: HcsOnly, nowMs: number = Date.now()): Promise<AppealView[]> {
  const topic = getTopicId("forum");
  if (!topic) return [];
  let messages;
  try {
    messages = await deps.hcs.queryAll(topic);
  } catch {
    return [];
  }
  const appeals = collectAppealEvents(messages);
  const resolutions = collectEnforcementEvents(messages).filter(
    (e): e is AppealResolveMessage => e.kind === "appeal-resolve",
  );
  const events = collectEnforcementEvents(messages);
  const out: AppealView[] = [];
  for (const a of pendingAppeals(appeals, resolutions)) {
    const c = canonicalAddress(a.wallet)!;
    const state = getEnforcementState(c, events, nowMs);
    out.push({
      wallet: c,
      reporter: a.author,
      reason: a.reason,
      ts: a.ts,
      restriction:
        state.status === "clean"
          ? null
          : { status: state.status, reason: state.reason, remainingMs: state.remainingMs, expiresAt: state.expiresAt },
    });
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out;
}
