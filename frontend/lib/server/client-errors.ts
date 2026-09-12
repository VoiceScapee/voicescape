/**
 * Voicescape — privacy-first client error reporting.
 *
 * When a user's browser hits an uncaught JS error, the client sends a
 * minimal report to POST /api/client-error. The server stores AGGREGATE
 * counts only — never anything that identifies who hit the error:
 *
 *   stored:   errors:agg:<date>:<page-slug>:<hash> → {page, message, component, count, firstSeen, lastSeen}
 *   NOT stored: IP addresses, user agents, wallet addresses, full URLs
 *                (query strings / fragments are stripped), stack traces.
 *
 * All keys carry a 7-day TTL and auto-expire. Recording is best-effort:
 * it never throws, so error telemetry can never break the app.
 *
 * The admin endpoint (GET /api/admin/errors) is founder-gated: the
 * request must carry a valid wallet session whose address is in the
 * founder wallet set (FOUNDER_WALLETS env, falling back to the public
 * NEXT_PUBLIC_TREASURY_ADDRESS).
 */
import type { KvStore } from "./store";
import { getKvStore } from "./store";

export const CLIENT_ERROR_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
export const MAX_ERROR_MESSAGE_LEN = 200;
export const MAX_ERROR_PAGE_LEN = 120;
export const MAX_ERROR_COMPONENT_LEN = 40;
export const MAX_ERRORS_INDEXED_PER_DAY = 100;
export const ERROR_STATS_DAY_COUNT = 7;

/* ------------------------------------------------------------------ */
/* Normalizers (privacy boundary — everything untrusted gets cleaned)  */
/* ------------------------------------------------------------------ */

/** UTC date key: YYYY-MM-DD. */
export function errorDateKey(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Pathname only. Strips query strings and fragments (they can carry PII
 * like tokens), requires a leading "/", caps length. Null when unusable.
 */
export function normalizeErrorPage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim();
  // Strip query string and fragment before anything else.
  p = p.split("?")[0].split("#")[0];
  if (!p.startsWith("/")) return null;
  p = p.replace(/\s+/g, " ").slice(0, MAX_ERROR_PAGE_LEN);
  // Allow only URL-safe pathname characters; collapse the rest.
  p = p.replace(/[^a-zA-Z0-9\-_./~%]/g, "");
  if (!p || p.length > MAX_ERROR_PAGE_LEN) return null;
  return p || null;
}

/**
 * Scrub values that could identify someone from an error message:
 * EVM addresses and Hedera account IDs. Keeps the message useful
 * ("insufficient balance for 0x…") without storing identifiers.
 */
export function scrubErrorMessage(msg: string): string {
  return msg
    .replace(/0x[a-fA-F0-9]{8,}/g, "0x…")
    .replace(/\b\d{1,10}\.\d{1,10}\.\d{1,10}\b/g, "0.0.…");
}

/**
 * Error message, scrubbed of identifiers, truncated to 200 chars,
 * whitespace collapsed. Null when empty. Never include stack traces —
 * callers pass `error.message` only.
 */
export function normalizeErrorMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const msg = scrubErrorMessage(raw.trim().replace(/\s+/g, " ")).slice(0, MAX_ERROR_MESSAGE_LEN);
  return msg || null;
}

/** Optional component/tag slug. Null when unusable. */
export function normalizeErrorComponent(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") return null;
  const c = raw.trim().toLowerCase().slice(0, MAX_ERROR_COMPONENT_LEN).replace(/[^a-z0-9_-]/g, "");
  return c || null;
}

/** FNV-1a 32-bit hash → 8 hex chars. Buckets identical reports together. */
export function hashErrorMessage(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** URL-safe slug of a pathname for use inside store keys. */
export function slugifyErrorPage(page: string): string {
  const s = page
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "root";
}

export function errorAggKey(date: string, page: string, hash: string): string {
  return `errors:agg:${date}:${slugifyErrorPage(page)}:${hash}`;
}

export function errorIndexKey(date: string): string {
  return `errors:index:${date}`;
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

export interface ErrorAggregate {
  page: string;
  message: string;
  component: string | null;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

/**
 * Record one client error report. Best-effort: never throws. Aggregates
 * identical (page, component, message) reports per UTC day and keeps a
 * bounded index of aggregate keys so the admin view can list them.
 */
export async function recordClientError(
  store: KvStore,
  pageRaw: unknown,
  messageRaw: unknown,
  componentRaw: unknown = null,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const page = normalizeErrorPage(pageRaw);
  const message = normalizeErrorMessage(messageRaw);
  if (!page || !message) return false;
  const component = normalizeErrorComponent(componentRaw);
  try {
    const date = errorDateKey(new Date(nowMs));
    const hash = hashErrorMessage(`${page}|${component ?? ""}|${message}`);
    const key = errorAggKey(date, page, hash);

    let agg: ErrorAggregate | null = null;
    try {
      const raw = await store.get(key);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ErrorAggregate>;
        if (parsed && typeof parsed.count === "number") {
          agg = {
            page,
            message,
            component,
            count: parsed.count,
            firstSeen: typeof parsed.firstSeen === "number" ? parsed.firstSeen : nowMs,
            lastSeen: nowMs,
          };
        }
      }
    } catch {
      agg = null;
    }
    if (!agg) {
      agg = { page, message, component, count: 0, firstSeen: nowMs, lastSeen: nowMs };
    }
    agg.count += 1;
    agg.lastSeen = nowMs;
    await store.set(key, JSON.stringify(agg), CLIENT_ERROR_TTL_MS);

    // Bounded per-day index of aggregate keys (best-effort).
    try {
      const idxKey = errorIndexKey(date);
      const rawIdx = await store.get(idxKey);
      const idx: string[] = rawIdx ? (JSON.parse(rawIdx) as string[]) : [];
      const list = Array.isArray(idx) ? idx.filter((k): k is string => typeof k === "string") : [];
      if (!list.includes(key)) {
        list.push(key);
        while (list.length > MAX_ERRORS_INDEXED_PER_DAY) list.shift();
        await store.set(idxKey, JSON.stringify(list), CLIENT_ERROR_TTL_MS);
      }
    } catch {
      /* index is best-effort; the aggregate itself is already stored */
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Admin read                                                          */
/* ------------------------------------------------------------------ */

/** Aggregates for the last `days` UTC days, sorted by count desc. */
export async function getErrorAggregates(
  store: KvStore,
  days: number = ERROR_STATS_DAY_COUNT,
  nowMs: number = Date.now(),
): Promise<ErrorAggregate[]> {
  const dates: string[] = [];
  const n = Math.max(1, Math.min(30, Math.floor(days)));
  for (let i = 0; i < n; i++) {
    dates.push(errorDateKey(new Date(nowMs - i * 86400_000)));
  }
  const out: ErrorAggregate[] = [];
  for (const date of dates) {
    let keys: string[] = [];
    try {
      const raw = await store.get(errorIndexKey(date));
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) keys = parsed.filter((k): k is string => typeof k === "string");
      }
    } catch {
      continue;
    }
    for (const key of keys.slice(0, MAX_ERRORS_INDEXED_PER_DAY)) {
      try {
        const raw = await store.get(key);
        if (!raw) continue;
        const agg = JSON.parse(raw) as Partial<ErrorAggregate>;
        if (agg && typeof agg.count === "number" && typeof agg.message === "string") {
          out.push({
            page: typeof agg.page === "string" ? agg.page : "?",
            message: agg.message.slice(0, MAX_ERROR_MESSAGE_LEN),
            component: typeof agg.component === "string" ? agg.component : null,
            count: agg.count,
            firstSeen: typeof agg.firstSeen === "number" ? agg.firstSeen : 0,
            lastSeen: typeof agg.lastSeen === "number" ? agg.lastSeen : 0,
          });
        }
      } catch {
        /* skip undecodable entries */
      }
    }
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

/* ------------------------------------------------------------------ */
/* Founder gate (server-only)                                          */
/* ------------------------------------------------------------------ */

/**
 * Wallet addresses allowed to view the error dashboard. Configured via
 * FOUNDER_WALLETS (comma-separated); falls back to the public treasury
 * address, which is the founder's wallet. Comparison is case-insensitive.
 * Kept here (server-only) so the list never ships to the browser.
 */
export function founderWallets(env: Record<string, string | undefined> = process.env): string[] {
  // Founder is always 0.0.10424063 (the treasury wallet).
  const list = ["0.0.10424063"];
  const extra = (env.FOUNDER_WALLETS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const w of extra) {
    if (!list.includes(w)) list.push(w);
  }
  return list;
}

/**
 * Normalize a session address to Hedera ID format for founder comparison.
 * Sessions store the canonical long-zero EVM form (0x000...9f0eff);
 * this converts it back to 0.0.10424063.
 */
function normalizeToHederaId(address: string): string {
  const lower = address.trim().toLowerCase();
  // Long-zero EVM form: 0x00000000000000000000000000000000009f0eff -> 0.0.10424063
  const m = /^0x0*([0-9a-f]+)$/.exec(lower);
  if (m) {
    try {
      const num = BigInt("0x" + m[1]);
      // Only convert if it fits in the Hedera account range (small numbers)
      if (num < BigInt("0xffffffff")) {
        return `0.0.${num.toString()}`;
      }
    } catch {
      // fall through
    }
  }
  return lower;
}

/** True when the (session-verified) wallet address belongs to a founder. */
export function isFounderWallet(
  address: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!address) return false;
  const normalized = normalizeToHederaId(address);
  return founderWallets(env).includes(normalized);
}

export interface ClientErrorAdminDeps {
  store: KvStore;
  verifySession: (cred: unknown) => Promise<{ ok: true; address: string } | { ok: false; error: string }>;
  env?: Record<string, string | undefined>;
}

export interface AdminErrorsResult {
  status: number;
  json: unknown;
}

/**
 * Founder-only error aggregates. 401 bad/missing session · 403 not a
 * founder wallet. The wallet address in the session is HMAC-verified, so
 * the founder check is trustworthy.
 */
export async function getClientErrorStats(
  deps: ClientErrorAdminDeps,
  cred: unknown,
): Promise<AdminErrorsResult> {
  if (cred == null) return { status: 401, json: { error: "sign in with your wallet to view error reports" } };
  const verified = await deps.verifySession(cred);
  if (!verified.ok) return { status: 401, json: { error: verified.error } };
  if (!isFounderWallet(verified.address, deps.env ?? process.env)) {
    return { status: 403, json: { error: "error reports are private — founders only" } };
  }
  try {
    const errors = await getErrorAggregates(deps.store);
    return { status: 200, json: { errors, days: ERROR_STATS_DAY_COUNT } };
  } catch {
    return { status: 503, json: { error: "could not read error reports — try again in a moment" } };
  }
}

/** Production wiring: real store + session auth port. */
export function defaultClientErrorAdminDeps(): ClientErrorAdminDeps {
  return {
    store: getKvStore(),
    verifySession: async (cred: unknown) => {
      const { defaultAuthPort } = await import("./townhall/auth");
      const res = await defaultAuthPort().verifySession(cred);
      return res.ok ? { ok: true as const, address: res.session.address } : { ok: false as const, error: res.error };
    },
  };
}
