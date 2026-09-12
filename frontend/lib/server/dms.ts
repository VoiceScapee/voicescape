/**
 * Voicescape — direct-message domain logic.
 *
 * Extracted from the /api/dms route so the send/receive/block/report flow
 * is unit-testable against an in-memory store. The route handler stays
 * thin: auth, IP gate, then delegates here.
 *
 * Storage: shared KvStore. Threads and inboxes carry a 30-day TTL.
 * Privacy: every message body passes checkContent before storage —
 * no phone/email may enter the system, DMs included.
 */

import { checkContent } from "./townhall/content-filter";
import type { KvStore } from "./store";
import type { QuotaStore } from "./quota";

export const DM_MAX_LEN = 1000;
export const DM_THREAD_CAP = 100;
export const DM_INBOX_CAP = 20;
export const DM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const DM_DAILY_LIMIT_FALLBACK = 50;
export const DM_REPORT_DAILY_LIMIT_FALLBACK = 10;
export const ADDR_RE = /^0x[0-9a-f]{40}$/;

export interface DmMessage {
  from: string;
  to: string;
  message: string;
  timestamp: number;
}

export interface DmConversation {
  with: string;
  lastMessage: string;
  timestamp: number;
}

export interface DmReport {
  reporter: string;
  reported: string;
  reason: string;
  timestamp: number;
}

export type DmSendResult =
  | { ok: true; timestamp: number }
  | { ok: false; status: number; error: string };

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

export function sortAddrs(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

export function dmThreadKey(a: string, b: string): string {
  const [a1, a2] = sortAddrs(a, b);
  return `dm:thread:${a1}:${a2}`;
}

export function dmLockKey(a: string, b: string): string {
  const [a1, a2] = sortAddrs(a, b);
  return `dm:lock:${a1}:${a2}`;
}

export function dmInboxKey(user: string): string {
  return `dm:inbox:${user.toLowerCase()}`;
}

export function dmBlockKey(user: string): string {
  return `dm:block:${user.toLowerCase()}`;
}

export function dmReportKey(reporter: string, ts: number): string {
  return `dm:report:${reporter.toLowerCase()}:${ts}`;
}

const DM_REPORT_INDEX_KEY = "dm:report:index";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

async function readJson<T>(store: KvStore, key: string, fallback: T): Promise<T> {
  try {
    const raw = await store.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Per-thread write lock so two concurrent sends (A→B and B→A racing,
 * or two tabs) can't lose a message in the read-modify-write window.
 * Lock TTL is short; acquisition fails closed (503) after a few retries.
 */
export async function withDmLock<T>(store: KvStore, a: string, b: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = dmLockKey(a, b);
  let acquired = false;
  for (let i = 0; i < 5; i++) {
    acquired = await store.setNx(lockKey, "1", 5000);
    if (acquired) break;
    await new Promise((r) => setTimeout(r, 50 * (i + 1)));
  }
  if (!acquired) throw new Error("dm-lock-unavailable");
  try {
    return await fn();
  } finally {
    await store.del(lockKey).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Blocking                                                            */
/* ------------------------------------------------------------------ */

/** Addresses `user` has blocked. */
export async function getBlocked(store: KvStore, user: string): Promise<string[]> {
  return readJson<string[]>(store, dmBlockKey(user), []);
}

/** True when `blocker` has blocked `addr`. */
export async function isBlockedBy(store: KvStore, blocker: string, addr: string): Promise<boolean> {
  const list = await getBlocked(store, blocker);
  return list.includes(addr.toLowerCase());
}

/** Block or unblock `addr` for `user`. Returns the updated block list. */
export async function setBlocked(
  store: KvStore,
  user: string,
  addr: string,
  block: boolean,
): Promise<string[]> {
  const me = user.toLowerCase();
  const target = addr.toLowerCase();
  if (!ADDR_RE.test(target)) throw new Error("invalid-address");
  if (target === me) throw new Error("cannot-block-self");
  let list = await getBlocked(store, me);
  if (block) {
    if (!list.includes(target)) list = [...list, target];
  } else {
    list = list.filter((x) => x !== target);
  }
  await store.set(dmBlockKey(me), JSON.stringify(list), DM_TTL_MS);
  return list;
}

/* ------------------------------------------------------------------ */
/* Send                                                                */
/* ------------------------------------------------------------------ */

export interface DmSendDeps {
  store: KvStore;
  quota: QuotaStore;
  /** Per-wallet daily send limit. */
  dmLimit: number;
}

/**
 * Validate, PII-gate, block-check, quota-check, then store a DM.
 * Returns {ok:true} or {ok:false, status, error} — the route maps these
 * directly to HTTP so failures are always visible to the user.
 */
export async function sendDm(deps: DmSendDeps, from: string, to: string, message: string): Promise<DmSendResult> {
  const sender = from.toLowerCase();
  const recipient = (to ?? "").toLowerCase();
  const body = (message ?? "").trim();

  if (!ADDR_RE.test(recipient)) return { ok: false, status: 400, error: "Invalid recipient address" };
  if (!body || body.length > DM_MAX_LEN)
    return { ok: false, status: 400, error: "Message must be 1-1000 chars" };
  if (recipient === sender) return { ok: false, status: 400, error: "Cannot DM yourself" };

  // Privacy rule: no phone/email/real-name sharing anywhere on Voicescape —
  // DMs included. Wallet connection is the only identity.
  const contentCheck = checkContent(body, "DM");
  if (!contentCheck.allowed)
    return { ok: false, status: 400, error: contentCheck.reason ?? "message blocked" };

  // Block check: the recipient may have blocked the sender.
  if (await isBlockedBy(deps.store, recipient, sender))
    return { ok: false, status: 403, error: "This user has blocked you" };

  // Per-wallet daily quota (Sybil bound #1).
  let q;
  try {
    q = await deps.quota.consume("dm:send", sender, deps.dmLimit);
  } catch {
    return { ok: false, status: 503, error: "Temporarily unavailable — please retry in a moment" };
  }
  if (!q.allowed)
    return {
      ok: false,
      status: 429,
      error: `DM limit reached (${deps.dmLimit}/day) — try again tomorrow`,
    };

  const msg: DmMessage = { from: sender, to: recipient, message: body, timestamp: Date.now() };

  try {
    await withDmLock(deps.store, sender, recipient, async () => {
      // Append to thread (cap at last 100)
      const threadKey = dmThreadKey(sender, recipient);
      const thread = await readJson<DmMessage[]>(deps.store, threadKey, []);
      thread.push(msg);
      const capped = thread.length > DM_THREAD_CAP ? thread.slice(-DM_THREAD_CAP) : thread;
      await deps.store.set(threadKey, JSON.stringify(capped), DM_TTL_MS);

      // Update inbox preview for both sides (cap at 20 conversations)
      for (const [user, other] of [[sender, recipient], [recipient, sender]] as const) {
        const inboxKey = dmInboxKey(user);
        let inbox = await readJson<DmConversation[]>(deps.store, inboxKey, []);
        inbox = inbox.filter((c) => c.with !== other);
        inbox.unshift({ with: other, lastMessage: body.slice(0, 50), timestamp: msg.timestamp });
        if (inbox.length > DM_INBOX_CAP) inbox = inbox.slice(0, DM_INBOX_CAP);
        await deps.store.set(inboxKey, JSON.stringify(inbox), DM_TTL_MS);
      }
    });
  } catch (e) {
    if (e instanceof Error && e.message === "dm-lock-unavailable")
      return { ok: false, status: 503, error: "Temporarily unavailable — please retry in a moment" };
    throw e;
  }

  return { ok: true, timestamp: msg.timestamp };
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

export async function getThread(store: KvStore, me: string, withAddr: string): Promise<DmMessage[]> {
  return readJson<DmMessage[]>(store, dmThreadKey(me, withAddr), []);
}

export async function getInbox(store: KvStore, me: string): Promise<DmConversation[]> {
  return readJson<DmConversation[]>(store, dmInboxKey(me), []);
}

/* ------------------------------------------------------------------ */
/* Reports (founder-reviewed)                                          */
/* ------------------------------------------------------------------ */

export interface DmReportDeps {
  store: KvStore;
  quota: QuotaStore;
  reportLimit: number;
}

export type DmReportResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * File a report against a DM sender. Stored off-chain in KV, visible only
 * to the founder via /api/admin/dm-reports. The reason is NOT run through
 * the content filter (same rationale as town-hall reports: a reporter
 * describing violating content must not be blocked for quoting it) —
 * but it is length-capped and rate-limited.
 */
export async function reportDm(
  deps: DmReportDeps,
  reporter: string,
  reported: string,
  reason: string,
): Promise<DmReportResult> {
  const who = reporter.toLowerCase();
  const target = (reported ?? "").toLowerCase();
  const why = (reason ?? "").trim();

  if (!ADDR_RE.test(target)) return { ok: false, status: 400, error: "Invalid address" };
  if (why.length < 10) return { ok: false, status: 400, error: "Reason must be at least 10 characters" };
  if (why.length > 500) return { ok: false, status: 400, error: "Reason too long (max 500 chars)" };

  let q;
  try {
    q = await deps.quota.consume("dm:report", who, deps.reportLimit);
  } catch {
    return { ok: false, status: 503, error: "Temporarily unavailable — please retry in a moment" };
  }
  if (!q.allowed)
    return { ok: false, status: 429, error: "Report limit reached — try again tomorrow" };

  const ts = Date.now();
  const entry: DmReport = { reporter: who, reported: target, reason: why, timestamp: ts };
  const key = dmReportKey(who, ts);
  await deps.store.set(key, JSON.stringify(entry), DM_TTL_MS);

  // Append to the admin index (best effort; the report key itself is the source of truth).
  try {
    await withDmLock(deps.store, "report", "index", async () => {
      const index = await readJson<string[]>(deps.store, DM_REPORT_INDEX_KEY, []);
      index.push(key);
      await deps.store.set(DM_REPORT_INDEX_KEY, JSON.stringify(index.slice(-200)), DM_TTL_MS);
    });
  } catch {
    // Index write failed — the report is still stored; admin listing degrades gracefully.
  }

  return { ok: true };
}

/** All reports, newest first (founder-only callers). */
export async function listDmReports(store: KvStore): Promise<DmReport[]> {
  const index = await readJson<string[]>(store, DM_REPORT_INDEX_KEY, []);
  const out: DmReport[] = [];
  for (const key of index) {
    const entry = await readJson<DmReport | null>(store, key, null);
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}
