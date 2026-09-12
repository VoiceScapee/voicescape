/**
 * Voicescape — creator analytics.
 *
 * Lightweight, privacy-respecting stats for page owners:
 *   - page views (per-day counters in the shared KvStore, 30-day TTL)
 *   - tips received (on-chain Tips contract events via mirror node)
 *   - referrals (existing HCS referral records)
 *   - badges (existing badge derivation)
 *
 * View tracking is fire-and-forget from the client; the /api/analytics/view
 * route never fails the page load (fail-open). Stats are only ever served
 * to the page owner — the session wallet must own the username.
 */
import { ethers } from "ethers";
import { getKvStore, type KvStore } from "./store";
import { mirrorBaseUrl } from "./townhall/topics";
import { checkContent } from "./townhall/content-filter";

export const ANALYTICS_VIEW_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
export const PAGE_SUBJECT = "page";
export const TINYBAR_PER_HBAR = 100_000_000n;
const MAX_SUBJECTS_PER_USER = 50;
const STATS_DAY_COUNT = 30;

/* ------------------------------------------------------------------ */
/* Key helpers                                                        */
/* ------------------------------------------------------------------ */

/** UTC date key: YYYY-MM-DD. */
export function viewDateKey(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Lowercase username slug; null when unusable. */
export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().toLowerCase();
  if (!name || name.length > 64) return null;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) return null;
  return name;
}

/** Subject slug ("page", "listing:<id>", …). Always returns something. */
export function normalizeSubject(raw: unknown): string {
  if (typeof raw !== "string") return PAGE_SUBJECT;
  const clean = raw.trim().toLowerCase().slice(0, 80).replace(/[^a-z0-9:_-]/g, "");
  return clean || PAGE_SUBJECT;
}

/** Optional human label for a subject (listing title, …). Null when unusable.
 *  Privacy: runs through the content filter — a modified client could
 *  otherwise store phone/email in this free-text field. */
export function normalizeLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!label) return null;
  const check = checkContent(label, "label");
  if (!check.allowed) return null;
  return label;
}

export function viewKey(username: string, subject: string, date: string): string {
  return `analytics:views:${username}:${subject}:${date}`;
}

export function subjectsKey(username: string): string {
  return `analytics:subjects:${username}`;
}

export function labelsKey(username: string): string {
  return `analytics:labels:${username}`;
}

/* ------------------------------------------------------------------ */
/* View recording                                                     */
/* ------------------------------------------------------------------ */

/**
 * Record one view. Best-effort: the subject/label indexes may lose an
 * entry under concurrent races; counters are the source of truth.
 */
export async function recordPageView(
  store: KvStore,
  username: string,
  subject: string = PAGE_SUBJECT,
  label: string | null = null,
  nowMs: number = Date.now(),
): Promise<void> {
  const date = viewDateKey(new Date(nowMs));
  await store.incr(viewKey(username, subject, date), ANALYTICS_VIEW_TTL_MS);
  try {
    const raw = await store.get(subjectsKey(username));
    const list: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    if (Array.isArray(list) && !list.includes(subject)) {
      list.push(subject);
      while (list.length > MAX_SUBJECTS_PER_USER) list.shift();
      await store.set(subjectsKey(username), JSON.stringify(list), ANALYTICS_VIEW_TTL_MS);
    }
  } catch {
    /* subject index is best-effort */
  }
  if (label) {
    try {
      const raw = await store.get(labelsKey(username));
      const map: Record<string, string> =
        raw && typeof JSON.parse(raw) === "object" ? (JSON.parse(raw) as Record<string, string>) : {};
      if (map[subject] !== label) {
        map[subject] = label;
        await store.set(labelsKey(username), JSON.stringify(map), ANALYTICS_VIEW_TTL_MS);
      }
    } catch {
      /* label index is best-effort */
    }
  }
}

export interface DailyViews {
  date: string;
  views: number;
}

export interface SubjectViews {
  subject: string;
  label: string | null;
  views: number;
}

export interface ViewStats {
  /** Sum of the retained window (counters expire after 30 days). */
  totalViews: number;
  viewsLast7d: number;
  viewsLast30d: number;
  /** Oldest → newest, always 30 entries. */
  daily: DailyViews[];
  /** Non-page subjects by 30-day views, top 5. */
  topSubjects: SubjectViews[];
}

async function readJsonArray(store: KvStore, key: string): Promise<string[]> {
  try {
    const raw = await store.get(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

async function readJsonMap(store: KvStore, key: string): Promise<Record<string, string>> {
  try {
    const raw = await store.get(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export async function getViewStats(
  store: KvStore,
  username: string,
  nowMs: number = Date.now(),
): Promise<ViewStats> {
  const dates: string[] = [];
  for (let i = STATS_DAY_COUNT - 1; i >= 0; i--) {
    dates.push(viewDateKey(new Date(nowMs - i * 86400_000)));
  }
  const subjects = [PAGE_SUBJECT];
  for (const s of await readJsonArray(store, subjectsKey(username))) {
    const n = normalizeSubject(s);
    if (!subjects.includes(n)) subjects.push(n);
  }
  const labels = await readJsonMap(store, labelsKey(username));

  const counts = new Map<string, number>();
  await Promise.all(
    dates.map((date) =>
      Promise.all(
        subjects.map(async (subject) => {
          try {
            const v = await store.get(viewKey(username, subject, date));
            const n = v ? Number(v) : 0;
            if (Number.isFinite(n) && n > 0) counts.set(`${subject}|${date}`, n);
          } catch {
            /* treat as zero */
          }
        }),
      ),
    ),
  );

  const daily: DailyViews[] = dates.map((date) => {
    let views = 0;
    for (const subject of subjects) views += counts.get(`${subject}|${date}`) ?? 0;
    return { date, views };
  });
  const viewsLast7d = daily.slice(-7).reduce((a, d) => a + d.views, 0);
  const viewsLast30d = daily.reduce((a, d) => a + d.views, 0);

  const topSubjects: SubjectViews[] = subjects
    .filter((s) => s !== PAGE_SUBJECT)
    .map((subject) => {
      let views = 0;
      for (const date of dates) views += counts.get(`${subject}|${date}`) ?? 0;
      return { subject, label: labels[subject] ?? null, views };
    })
    .filter((s) => s.views > 0)
    .sort((a, b) => b.views - a.views)
    .slice(0, 5);

  return { totalViews: viewsLast30d, viewsLast7d, viewsLast30d, daily, topSubjects };
}

/* ------------------------------------------------------------------ */
/* On-chain tips (mirror node, fail-open)                             */
/* ------------------------------------------------------------------ */

const TIPSENT_IFACE = new ethers.Interface([
  "event TipSent(string indexed username, address indexed from, address indexed toOwner, uint256 amount, uint256 fee)",
]);
const PURCHASE_IFACE = new ethers.Interface([
  "event PurchaseCompleted(address indexed buyer, address indexed seller, string listingRef, uint256 amount, uint256 fee)",
]);

function tipsContract(): string | null {
  const a = process.env.NEXT_PUBLIC_TIPS_ADDRESS;
  return a && a.trim() ? a.trim() : null;
}

function paddedTopic(hexAddr: string): string {
  return "0x" + hexAddr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

interface MirrorLogsResponse {
  logs?: { topics?: string[]; data?: string }[];
  links?: { next?: string | null };
}

async function fetchLogPages(firstUrl: string, cap: number): Promise<NonNullable<MirrorLogsResponse["logs"]>> {
  const out: NonNullable<MirrorLogsResponse["logs"]> = [];
  let url: string | null = firstUrl;
  for (let page = 0; page < cap && url; page++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`mirror ${res.status}`);
    const data = (await res.json()) as MirrorLogsResponse;
    for (const log of data.logs ?? []) out.push(log);
    url = data.links?.next ? `${mirrorBaseUrl()}${data.links.next}` : null;
  }
  return out;
}

export interface TipsReceived {
  totalTinybar: bigint;
  count: number;
}

/**
 * Sum of completed on-chain payments TO a wallet: TipSent (toOwner =
 * topic3) + PurchaseCompleted (seller = topic2). Bounded pages;
 * fail-open → zeros.
 */
export async function getTipsForWallet(wallet: string): Promise<TipsReceived> {
  const contract = tipsContract();
  if (!contract) return { totalTinybar: 0n, count: 0 };
  const walletTopic = paddedTopic(wallet);
  const base = `${mirrorBaseUrl()}/api/v1/contracts/${contract}/results/logs`;
  try {
    const [tips, sales] = await Promise.all([
      fetchLogPages(
        `${base}?${new URLSearchParams({ order: "asc", limit: "100", topic0: TIPSENT_IFACE.getEvent("TipSent")!.topicHash, topic3: walletTopic })}`,
        5,
      ),
      fetchLogPages(
        `${base}?${new URLSearchParams({ order: "asc", limit: "100", topic0: PURCHASE_IFACE.getEvent("PurchaseCompleted")!.topicHash, topic2: walletTopic })}`,
        5,
      ),
    ]);
    let total = 0n;
    let count = 0;
    for (const log of tips) {
      try {
        const parsed = TIPSENT_IFACE.decodeEventLog("TipSent", log.data ?? "0x", log.topics ?? []);
        total += BigInt(parsed.amount.toString());
        count++;
      } catch {
        /* undecodable — skip */
      }
    }
    for (const log of sales) {
      try {
        const parsed = PURCHASE_IFACE.decodeEventLog("PurchaseCompleted", log.data ?? "0x", log.topics ?? []);
        total += BigInt(parsed.amount.toString());
        count++;
      } catch {
        /* undecodable — skip */
      }
    }
    return { totalTinybar: total, count };
  } catch {
    return { totalTinybar: 0n, count: 0 };
  }
}

/** Tinybar → HBAR, rounded to 4 decimals for display. */
export function tinybarToHbar(tinybar: bigint): number {
  const whole = tinybar / TINYBAR_PER_HBAR;
  const frac = tinybar % TINYBAR_PER_HBAR;
  return Number(whole) + Number(frac) / 100_000_000;
}

/* ------------------------------------------------------------------ */
/* Creator stats (owner-only)                                         */
/* ------------------------------------------------------------------ */

export interface AnalyticsDeps {
  store: KvStore;
  verifySession: (cred: unknown) => Promise<{ ok: true; address: string } | { ok: false; error: string }>;
  resolveOwner: (username: string) => Promise<string | null>;
  tipsForWallet: (wallet: string) => Promise<TipsReceived>;
  referralCount: (username: string) => Promise<number>;
  badgeCount: (username: string, wallet: string) => Promise<number>;
}

export interface CreatorStats {
  username: string;
  totalViews: number;
  viewsLast7d: number;
  viewsLast30d: number;
  daily: DailyViews[];
  topSubjects: SubjectViews[];
  totalTipsHbar: number;
  tipsCount: number;
  totalReferrals: number;
  badgesEarned: number;
}

export interface StatsResult {
  status: number;
  json: unknown;
}

function ok(json: unknown, status = 200): StatsResult {
  return { status, json };
}

function err(status: number, error: string): StatsResult {
  return { status, json: { error } };
}

/**
 * Full creator stats. The caller must be the page owner: the session
 * wallet address must match the on-chain registry owner (case-insensitive).
 * 401 bad/missing session · 404 username not registered · 403 not the owner.
 */
export async function getCreatorStats(
  deps: AnalyticsDeps,
  usernameRaw: unknown,
  cred: unknown,
): Promise<StatsResult> {
  const username = normalizeUsername(usernameRaw);
  if (!username) return err(400, "username is required");
  if (cred == null) return err(401, "sign in with your wallet to view analytics");
  const verified = await deps.verifySession(cred);
  if (!verified.ok) return err(401, verified.error);
  let owner: string | null;
  try {
    owner = await deps.resolveOwner(username);
  } catch {
    return err(503, "could not resolve page ownership — try again in a moment");
  }
  if (!owner) return err(404, "page not found");
  if (owner.toLowerCase() !== verified.address.toLowerCase()) {
    return err(403, "analytics are private — only the page owner can view them");
  }
  const [views, tips, referrals, badges] = await Promise.all([
    getViewStats(deps.store, username).catch(
      (): ViewStats => ({ totalViews: 0, viewsLast7d: 0, viewsLast30d: 0, daily: [], topSubjects: [] }),
    ),
    deps.tipsForWallet(owner).catch((): TipsReceived => ({ totalTinybar: 0n, count: 0 })),
    deps.referralCount(username).catch(() => 0),
    deps.badgeCount(username, owner).catch(() => 0),
  ]);
  const stats: CreatorStats = {
    username,
    totalViews: views.totalViews,
    viewsLast7d: views.viewsLast7d,
    viewsLast30d: views.viewsLast30d,
    daily: views.daily,
    topSubjects: views.topSubjects,
    totalTipsHbar: Math.round(tinybarToHbar(tips.totalTinybar) * 10000) / 10000,
    tipsCount: tips.count,
    totalReferrals: referrals,
    badgesEarned: badges,
  };
  return ok(stats);
}

/** Production wiring: real store, auth, registry, mirror, HCS, badges. */
export function defaultAnalyticsDeps(): AnalyticsDeps {
  return {
    store: getKvStore(),
    verifySession: async (cred: unknown) => {
      const { defaultAuthPort } = await import("./townhall/auth");
      const res = await defaultAuthPort().verifySession(cred);
      return res.ok ? { ok: true as const, address: res.session.address } : { ok: false as const, error: res.error };
    },
    resolveOwner: async (username: string) => {
      const { resolveUsernameWallet } = await import("./townhall/badges");
      return resolveUsernameWallet(username);
    },
    tipsForWallet: (wallet: string) => getTipsForWallet(wallet),
    referralCount: async (username: string) => {
      const { defaultDeps, getReferralStats } = await import("./townhall/handlers");
      const res = await getReferralStats(defaultDeps(), username);
      if (res.status !== 200) return 0;
      const json = res.json as { totalReferrals?: unknown };
      return typeof json.totalReferrals === "number" ? json.totalReferrals : 0;
    },
    badgeCount: async (username: string, wallet: string) => {
      const { computeBadges, defaultDepsForBadges } = await import("./townhall/badges");
      const res = await computeBadges(defaultDepsForBadges().hcs, { username, wallet });
      return res.badges.length;
    },
  };
}
