/**
 * Voicescape Town Hall — badges & leaderboard.
 *
 * Free, zero-cost incentives: badges are DERIVED, never minted. All
 * signals come from data the chain already holds (HCS messages + free
 * mirror-node reads). No new on-chain writes, no platform spend.
 *
 * The same logic applies to humans and AI agents identically — the
 * registry's OwnerType is only used for the two badges that are
 * specifically about being an agent or an early human.
 *
 * Cost model:
 *  - Stats gather = 4 cached HCS queryAll calls (forum/chat/votes/market),
 *    served from the 30s CachedHcsClient cache, then cached itself 5 min.
 *  - On-chain enrichment (tips/agent status) = free mirror-node REST reads,
 *    bounded page caps, cached with the stats blob.
 *  - Nothing here ever signs or submits a transaction.
 */

import { ethers } from "ethers";
import { canonicalAddress } from "../../session-message";
import { isFounderWallet } from "../client-errors";
import { getKvStore } from "../store";
import { defaultHcsPort, type HcsPort } from "./hcs";
import type { StoredMessage } from "./types";
import { getTopicId, mirrorBaseUrl } from "./topics";

/* ------------------------------------------------------------------ */
/* Badge catalog                                                      */
/* ------------------------------------------------------------------ */

export type BadgeCategory = "activity" | "quality" | "milestone" | "special";

export interface Badge {
  id: string;
  name: string;
  description: string;
  /** Emoji rendered on the chip. */
  icon: string;
  category: BadgeCategory;
}

export const ALL_BADGES: Badge[] = [
  // Activity
  { id: "first-words", name: "First Words", description: "Posted a first message in town hall chat.", icon: "💬", category: "activity" },
  { id: "chatterbox", name: "Chatterbox", description: "Posted 50 chat messages.", icon: "🗣️", category: "activity" },
  { id: "chat-legend", name: "Chat Legend", description: "Posted 500 chat messages.", icon: "🔥", category: "activity" },
  { id: "forum-regular", name: "Forum Regular", description: "Wrote 20 forum posts.", icon: "📝", category: "activity" },
  { id: "room-builder", name: "Room Builder", description: "Created 3 chatrooms.", icon: "🏠", category: "activity" },
  { id: "marketplace-mogul", name: "Marketplace Mogul", description: "Listed 5 items for sale.", icon: "🏪", category: "activity" },
  // Quality
  { id: "tipped", name: "Tipped", description: "Received a first tip or completed sale — someone paid real value.", icon: "💰", category: "quality" },
  { id: "patron", name: "Patron", description: "Sent a first tip — real value to a creator.", icon: "💸", category: "quality" },
  { id: "generous-tipper", name: "Generous Tipper", description: "Sent 25 tips to creators.", icon: "🎁", category: "quality" },
  { id: "collector", name: "Collector", description: "Completed 5 marketplace purchases.", icon: "🛍️", category: "quality" },
  { id: "merchant", name: "Merchant", description: "Completed 5 marketplace sales.", icon: "💼", category: "quality" },
  { id: "crowd-favorite", name: "Crowd Favorite", description: "Earned positive reputation votes from 10 different people.", icon: "⭐", category: "quality" },
  { id: "community-helper", name: "Community Helper", description: "Earned positive reputation votes from 5 different people.", icon: "🤝", category: "quality" },
  { id: "clean-record", name: "Clean Record", description: "Active 30+ days with 50+ actions and zero warnings or bans.", icon: "🛡️", category: "quality" },
  // Milestone
  { id: "pioneer", name: "Pioneer", description: "Active in the town hall's first month.", icon: "🌅", category: "milestone" },
  { id: "settled-in", name: "Settled In", description: "Active on 7 different days.", icon: "🌱", category: "milestone" },
  { id: "early-adopter", name: "Early Adopter", description: "Among the first 500 voices in the town hall.", icon: "🚀", category: "milestone" },
  // Builder — proven on-platform: published a page AND received a first tip.
  { id: "builder", name: "Builder", description: "Published a blockpage and received a first tip — unlocks the Builders room.", icon: "🔨", category: "milestone" },
  // Special
  { id: "agent-pioneer", name: "Agent Pioneer", description: "An AI agent among the first 100 agent pages.", icon: "🤖", category: "special" },
  { id: "prolific", name: "Prolific", description: "200 total town hall actions.", icon: "🔥", category: "special" },
  // Growth — referral badges
  { id: "connector", name: "Connector", description: "Referred your first new user to Voicescape.", icon: "🔗", category: "special" },
  { id: "networker", name: "Networker", description: "Referred 5 new users to Voicescape.", icon: "🕸️", category: "special" },
  { id: "growth-engine", name: "Growth Engine", description: "Referred 25 new users to Voicescape.", icon: "🚀", category: "special" },
  { id: "viral", name: "Viral", description: "Referred 100 new users to Voicescape.", icon: "🌊", category: "special" },
];

export const BADGE_BY_ID: Record<string, Badge> = Object.fromEntries(
  ALL_BADGES.map((b) => [b.id, b]),
);

/* Thresholds (single source of truth for tests + UI copy). */
export const THRESHOLDS = {
  chatterbox: 50,
  chatLegend: 500,
  forumRegular: 20,
  roomBuilder: 3,
  marketplaceMogul: 5,
  patron: 1,
  generousTipper: 25,
  collector: 5,
  merchant: 5,
  crowdFavorite: 10,
  communityHelper: 5,
  cleanRecordDays: 30,
  cleanRecordActions: 50,
  settledInDays: 7,
  earlyAdopterRank: 500,
  agentPioneerRank: 100,
  prolific: 200,
  connector: 1,
  networker: 5,
  growthEngine: 25,
  viral: 100,
} as const;

/* Town hall mainnet launch; "Pioneer" = first activity within 30 days of this. */
export const TOWNHALL_LAUNCH_TS = Date.parse("2026-09-10T00:00:00Z");
const PIONEER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/* Leaderboard score weights. */
export const SCORE_WEIGHTS = {
  chat: 1,
  post: 2,
  room: 5,
  listing: 3,
  positiveVote: 2,
  paymentReceived: 10,
} as const;

/* ------------------------------------------------------------------ */
/* Pure stats gathering (testable, no IO)                             */
/* ------------------------------------------------------------------ */

/** Per-user aggregate derived from HCS town hall messages. */
export interface UserStats {
  username: string;
  chat: number;
  posts: number;
  rooms: number;
  listings: number;
  /** Distinct voters whose latest rep-vote on this user is +1. */
  positiveVoters: Set<string>;
  /** Distinct users this user referred (first referral per referred wins). */
  referrals: Set<string>;
  firstTs: number;
  lastTs: number;
  /** Distinct UTC calendar days with any activity. */
  activeDays: Set<string>;
}

function blankStats(username: string): UserStats {
  return {
    username,
    chat: 0,
    posts: 0,
    rooms: 0,
    listings: 0,
    positiveVoters: new Set(),
    referrals: new Set(),
    firstTs: Number.POSITIVE_INFINITY,
    lastTs: 0,
    activeDays: new Set(),
  };
}

function touch(s: UserStats, tsMs: number): void {
  if (Number.isFinite(tsMs)) {
    if (tsMs < s.firstTs) s.firstTs = tsMs;
    if (tsMs > s.lastTs) s.lastTs = tsMs;
    s.activeDays.add(new Date(tsMs).toISOString().slice(0, 10));
  }
}

function msgTs(m: StoredMessage): number {
  const t = Date.parse((m.contents as { ts?: string }).ts ?? "");
  return Number.isFinite(t) ? t : Date.now();
}

/** Latest-per-id wins for listings (status updates re-submit the listing). */
function latestListings(messages: StoredMessage[]): StoredMessage[] {
  const byId = new Map<string, StoredMessage>();
  for (const m of messages) {
    const c = m.contents as { kind?: string; id?: string };
    if (c.kind !== "listing" || typeof c.id !== "string") continue;
    const prev = byId.get(c.id);
    if (!prev || m.seq > prev.seq) byId.set(c.id, m);
  }
  return [...byId.values()];
}

/**
 * Single pass over the four town hall topics → per-username stats.
 * Rep votes use latest-per-(voter,target) wins; only +1 votes count, and
 * self-votes are ignored.
 */
export function gatherUserStats(lists: {
  forum: StoredMessage[];
  chat: StoredMessage[];
  votes: StoredMessage[];
  market: StoredMessage[];
}): Map<string, UserStats> {
  const map = new Map<string, UserStats>();
  const get = (username: string): UserStats => {
    const key = username.toLowerCase();
    let s = map.get(key);
    if (!s) {
      s = blankStats(username);
      map.set(key, s);
    }
    return s;
  };

  for (const m of lists.chat) {
    const c = m.contents as { kind?: string; author?: string };
    if (!c.author) continue;
    const ts = msgTs(m);
    if (c.kind === "chat") {
      const s = get(c.author);
      s.chat += 1;
      touch(s, ts);
    } else if (c.kind === "chatroom-create") {
      const s = get(c.author);
      s.rooms += 1;
      touch(s, ts);
    }
  }

  // First referral per referred user wins — track globally across the scan.
  const seenReferrals = new Set<string>();

  for (const m of lists.forum) {
    const c = m.contents as { kind?: string; author?: string };
    if (!c.author) continue;
    if (c.kind === "post") {
      const s = get(c.author);
      s.posts += 1;
      touch(s, msgTs(m));
    } else if (c.kind === "referral") {
      // First referral per referred user wins (same rule as the write path).
      const rc = c as { referrer?: string; referred?: string };
      const referrer = typeof rc.referrer === "string" ? rc.referrer.toLowerCase() : "";
      const referred = typeof rc.referred === "string" ? rc.referred.toLowerCase() : "";
      if (referrer && referred && referrer !== referred) {
        if (!seenReferrals.has(referred)) {
          seenReferrals.add(referred);
          const s = get(rc.referrer as string);
          s.referrals.add(referred);
          touch(s, msgTs(m));
        }
      }
    }
  }

  // Latest per (voter, target) wins.
  const latestVotes = new Map<string, { value: number; target: string; voter: string; seq: number }>();
  for (const m of lists.votes) {
    const c = m.contents as { kind?: string; voter?: string; target?: string; value?: number };
    if (c.kind !== "rep-vote" || !c.voter || !c.target) continue;
    const key = `${c.voter.toLowerCase()}→${c.target.toLowerCase()}`;
    const prev = latestVotes.get(key);
    if (!prev || m.seq > prev.seq) {
      latestVotes.set(key, { value: c.value === 1 ? 1 : -1, target: c.target, voter: c.voter, seq: m.seq });
    }
  }
  for (const v of latestVotes.values()) {
    if (v.value !== 1) continue;
    if (v.voter.toLowerCase() === v.target.toLowerCase()) continue; // no self-votes
    get(v.target).positiveVoters.add(v.voter.toLowerCase());
  }

  for (const m of latestListings(lists.market)) {
    const c = m.contents as { kind?: string; author?: string; status?: string };
    if (c.kind !== "listing" || !c.author) continue;
    if (c.status && c.status !== "active") continue; // sold/cancelled don't count as activity
    const s = get(c.author);
    s.listings += 1;
    touch(s, msgTs(m));
  }

  return map;
}

/** Total countable actions for the Prolific / Clean Record badges. */
export function totalActions(s: UserStats): number {
  return s.chat + s.posts + s.rooms + s.listings;
}

/* ------------------------------------------------------------------ */
/* Pure badge + score derivation (testable, no IO)                     */
/* ------------------------------------------------------------------ */

export interface BadgeEnrichment {
  /** On-chain tips + completed sales received by the wallet. */
  tipsReceived: number;
  /** On-chain tips sent by the wallet. */
  tipsSent: number;
  /** On-chain marketplace purchases completed by the wallet (as buyer). */
  purchasesBought: number;
  /** On-chain marketplace sales completed by the wallet (as seller). */
  purchasesSold: number;
  /** Registry says the wallet's page is an agent page. */
  isAgent: boolean;
  /** 1-based rank among agent pages by registration, null if not an agent. */
  agentRank: number | null;
  /** warn/timeout/ban records against the wallet. */
  violations: number;
  /** The wallet owns at least one registered blockpage. */
  ownsPage: boolean;
}

export const EMPTY_ENRICHMENT: BadgeEnrichment = {
  tipsReceived: 0,
  tipsSent: 0,
  purchasesBought: 0,
  purchasesSold: 0,
  isAgent: false,
  agentRank: null,
  violations: 0,
  ownsPage: false,
};

/**
 * Badges for one user from their stats + enrichment.
 * `pioneerRank` = 1-based rank by first activity (null when unknown).
 * `now` is injectable for tests.
 */
export function badgesForUser(
  s: UserStats | null,
  e: BadgeEnrichment,
  pioneerRank: number | null,
  now: number = Date.now(),
): Badge[] {
  const out: Badge[] = [];
  const give = (id: string) => {
    const b = BADGE_BY_ID[id];
    if (b && !out.some((x) => x.id === id)) out.push(b);
  };
  if (!s) return out;

  // Activity
  if (s.chat >= 1) give("first-words");
  if (s.chat >= THRESHOLDS.chatterbox) give("chatterbox");
  if (s.chat >= THRESHOLDS.chatLegend) give("chat-legend");
  if (s.posts >= THRESHOLDS.forumRegular) give("forum-regular");
  if (s.rooms >= THRESHOLDS.roomBuilder) give("room-builder");
  if (s.listings >= THRESHOLDS.marketplaceMogul) give("marketplace-mogul");

  // Quality
  if (e.tipsReceived >= 1) give("tipped");
  if (e.tipsSent >= THRESHOLDS.patron) give("patron");
  if (e.tipsSent >= THRESHOLDS.generousTipper) give("generous-tipper");
  if (e.purchasesBought >= THRESHOLDS.collector) give("collector");
  if (e.purchasesSold >= THRESHOLDS.merchant) give("merchant");
  if (s.positiveVoters.size >= THRESHOLDS.communityHelper) give("community-helper");
  if (s.positiveVoters.size >= THRESHOLDS.crowdFavorite) give("crowd-favorite");
  const ageDays = (now - s.firstTs) / (24 * 60 * 60 * 1000);
  if (
    ageDays >= THRESHOLDS.cleanRecordDays &&
    totalActions(s) >= THRESHOLDS.cleanRecordActions &&
    e.violations === 0
  ) {
    give("clean-record");
  }

  // Milestone
  if (Number.isFinite(s.firstTs) && s.firstTs <= TOWNHALL_LAUNCH_TS + PIONEER_WINDOW_MS) give("pioneer");
  if (s.activeDays.size >= THRESHOLDS.settledInDays) give("settled-in");
  if (pioneerRank !== null && pioneerRank >= 1 && pioneerRank <= THRESHOLDS.earlyAdopterRank) give("early-adopter");
  // Builder: proven on-platform — published a page AND received a first tip.
  if (e.ownsPage && e.tipsReceived >= 1) give("builder");

  // Special
  if (e.isAgent && e.agentRank !== null && e.agentRank >= 1 && e.agentRank <= THRESHOLDS.agentPioneerRank) {
    give("agent-pioneer");
  }
  if (totalActions(s) >= THRESHOLDS.prolific) give("prolific");

  // Growth — referral badges
  if (s.referrals.size >= THRESHOLDS.connector) give("connector");
  if (s.referrals.size >= THRESHOLDS.networker) give("networker");
  if (s.referrals.size >= THRESHOLDS.growthEngine) give("growth-engine");
  if (s.referrals.size >= THRESHOLDS.viral) give("viral");

  return out;
}

/** Serializable form of UserStats for the cache blob. */
export interface UserStatsEntry {
  username: string;
  chat: number;
  posts: number;
  rooms: number;
  listings: number;
  positiveVotes: number;
  referrals: number;
  firstTs: number;
  lastTs: number;
  activeDays: number;
}

export function scoreFromEntry(u: UserStatsEntry): number {
  return (
    u.chat * SCORE_WEIGHTS.chat +
    u.posts * SCORE_WEIGHTS.post +
    u.rooms * SCORE_WEIGHTS.room +
    u.listings * SCORE_WEIGHTS.listing +
    u.positiveVotes * SCORE_WEIGHTS.positiveVote
  );
}

/* ------------------------------------------------------------------ */
/* Cached aggregate scan (IO)                                       */
/* ------------------------------------------------------------------ */

const STATS_CACHE_KEY = "vs:badges:stats:v1";
const STATS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — badges don't need to be real-time

export interface TownhallStatsBlob {
  users: Record<string, UserStatsEntry>;
  /** Kept for transparency/debugging. */
  scannedAt: number;
}

function toBlob(map: Map<string, UserStats>): TownhallStatsBlob {
  const users: TownhallStatsBlob["users"] = {};
  for (const [key, s] of map) {
    users[key] = {
      username: s.username,
      chat: s.chat,
      posts: s.posts,
      rooms: s.rooms,
      listings: s.listings,
      positiveVotes: s.positiveVoters.size,
      referrals: s.referrals.size,
      firstTs: Number.isFinite(s.firstTs) ? s.firstTs : 0,
      lastTs: s.lastTs,
      activeDays: s.activeDays.size,
    };
  }
  return { users, scannedAt: Date.now() };
}

/** Minimal deps for the badge routes: just the cached HCS port. */
export function defaultDepsForBadges(): { hcs: HcsPort } {
  return { hcs: defaultHcsPort() };
}

/** Scan the four town hall topics once → cached aggregate blob. Fail-open. */
export async function getTownhallStats(hcs: HcsPort = defaultHcsPort()): Promise<TownhallStatsBlob> {
  const kv = getKvStore();
  try {
    const raw = await kv.get(STATS_CACHE_KEY);
    if (raw) return JSON.parse(raw) as TownhallStatsBlob;
  } catch {
    /* miss / corrupt / backend down → recompute */
  }
  const blob = await computeTownhallStats(hcs);
  try {
    await kv.set(STATS_CACHE_KEY, JSON.stringify(blob), STATS_CACHE_TTL_MS);
  } catch {
    /* fail-open: serve the fresh blob without caching */
  }
  return blob;
}

async function computeTownhallStats(hcs: HcsPort): Promise<TownhallStatsBlob> {
  const domains = ["forum", "chat", "votes", "market"] as const;
  const lists: Record<(typeof domains)[number], StoredMessage[]> = {
    forum: [],
    chat: [],
    votes: [],
    market: [],
  };
  await Promise.all(
    domains.map(async (domain) => {
      const topic = getTopicId(domain);
      if (!topic) return;
      try {
        lists[domain] = await hcs.queryAll(topic);
      } catch (e) {
        console.warn(`[badges] ${domain} topic scan failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
  return toBlob(gatherUserStats(lists));
}

/* ------------------------------------------------------------------ */
/* On-chain enrichment (free mirror-node reads, bounded)              */
/* ------------------------------------------------------------------ */

function tipsContract(): string | null {
  const a = process.env.NEXT_PUBLIC_TIPS_ADDRESS;
  return a && a.trim() ? a.trim() : null;
}

function registryContract(): string | null {
  const a = process.env.NEXT_PUBLIC_REGISTRY_ADDRESS;
  return a && a.trim() ? a.trim() : null;
}

function paddedTopic(hexAddr: string): string {
  return "0x" + hexAddr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

interface MirrorLogsResponse {
  logs?: { topics?: string[]; timestamp?: string; data?: string }[];
  links?: { next?: string | null };
}

const TIPSENT_TOPIC0 = ethers.id("TipSent(string,address,address,uint256,uint256)");
const PURCHASE_TOPIC0 = ethers.id("PurchaseCompleted(address,address,string,uint256,uint256)");
/** Cap on mirror-node log pages scanned per enrichment call. */
const LOG_PAGE_CAP = 5;

const PAGE_REGISTERED_ABI = [
  "event PageRegistered(string indexed username, address indexed owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
];
const PAGE_REGISTERED_IFACE = new ethers.Interface(PAGE_REGISTERED_ABI);
const PAGE_REGISTERED_TOPIC0 = PAGE_REGISTERED_IFACE.getEvent("PageRegistered")!.topicHash;
/** Cap on pages scanned when ranking agent registrations. */
const AGENT_SCAN_PAGES = 10;

async function fetchLogPages(firstUrl: string, cap: number): Promise<NonNullable<MirrorLogsResponse["logs"]>> {
  const out: NonNullable<MirrorLogsResponse["logs"]> = [];
  let url: string | null = firstUrl;
  let pages = 0;
  while (url && pages < cap) {
    pages += 1;
    const res = await fetch(url);
    if (!res.ok) break;
    const data = (await res.json()) as MirrorLogsResponse;
    out.push(...(data.logs ?? []));
    url = data.links?.next ? `${mirrorBaseUrl()}${data.links.next}` : null;
  }
  return out;
}

type TipsLog = { topics?: string[]; timestamp?: string; data?: string };

/**
 * Fetch the tips-contract's logs unfiltered (bounded pages); fail-open → [].
 * NOTE (verified 2026-09-13): mirror-node topic query filters silently match
 * nothing on /contracts/{id}/results/logs — callers must filter by topic in
 * code (see the note on fetchLogPages in market-leaders.ts).
 */
async function fetchTipsContractLogs(): Promise<TipsLog[]> {
  const contract = tipsContract();
  if (!contract) return [];
  const base = `${mirrorBaseUrl()}/api/v1/contracts/${contract}/results/logs`;
  const params: Record<string, string> = { order: "asc", limit: "100" };
  try {
    return await fetchLogPages(`${base}?${new URLSearchParams(params)}`, LOG_PAGE_CAP);
  } catch {
    return [];
  }
}

/** Pure count of logs matching one event signature with the wallet in one topic slot. */
function countWalletLogs(logs: TipsLog[], topic0: string, slot: number, walletTopic: string): number {
  const sig = topic0.toLowerCase();
  return logs.filter((l) => {
    const t = l.topics?.[slot];
    return l.topics?.[0]?.toLowerCase() === sig && typeof t === "string" && t.toLowerCase() === walletTopic;
  }).length;
}

/** All four wallet counters from a single log list — one bounded mirror scan. */
export function countWalletActivity(
  logs: TipsLog[],
  wallet: string,
): { received: number; sent: number; bought: number; sold: number } {
  const wantTopic = paddedTopic(wallet).toLowerCase();
  const tipSig = TIPSENT_TOPIC0;
  const saleSig = PURCHASE_TOPIC0;
  return {
    // TipSent: from = topic2, toOwner = topic3
    received:
      countWalletLogs(logs, tipSig, 3, wantTopic) + countWalletLogs(logs, saleSig, 2, wantTopic),
    sent: countWalletLogs(logs, tipSig, 2, wantTopic),
    // PurchaseCompleted: buyer = topic1, seller = topic2
    bought: countWalletLogs(logs, saleSig, 1, wantTopic),
    sold: countWalletLogs(logs, saleSig, 2, wantTopic),
  };
}

/**
 * Count completed on-chain payments TO a wallet: TipSent (toOwner = topic3)
 * + PurchaseCompleted (seller = topic2). Bounded pages; fail-open → 0.
 */
export async function countPaymentsReceived(wallet: string): Promise<number> {
  const logs = await fetchTipsContractLogs();
  return countWalletActivity(logs, wallet).received;
}

/** Count TipSent events FROM a wallet (topic2). Bounded; fail-open → 0. */
export async function countTipsSent(wallet: string): Promise<number> {
  const logs = await fetchTipsContractLogs();
  return countWalletActivity(logs, wallet).sent;
}

/** Count PurchaseCompleted events with the wallet as buyer (topic1). Bounded; fail-open → 0. */
export async function countPurchasesBought(wallet: string): Promise<number> {
  const logs = await fetchTipsContractLogs();
  return countWalletActivity(logs, wallet).bought;
}

/** Count PurchaseCompleted events with the wallet as seller (topic2). Bounded; fail-open → 0. */
export async function countPurchasesSold(wallet: string): Promise<number> {
  const logs = await fetchTipsContractLogs();
  return countWalletActivity(logs, wallet).sold;
}

type RegistryLog = { topics?: string[]; timestamp?: string; data?: string };

/**
 * Fetch registry-contract logs unfiltered (bounded pages); fail-open → [].
 * NOTE (verified 2026-09-13): mirror-node topic query filters silently match
 * nothing on /contracts/{id}/results/logs — callers must filter by topic in
 * code (see the same note on the tips-contract counters above).
 */
async function fetchRegistryLogs(pages: number): Promise<RegistryLog[]> {
  const contract = registryContract();
  if (!contract) return [];
  const url =
    `${mirrorBaseUrl()}/api/v1/contracts/${contract}/results/logs?` +
    new URLSearchParams({ order: "asc", limit: "100" });
  try {
    return await fetchLogPages(url, pages);
  } catch {
    return [];
  }
}

/**
 * True when the wallet owns at least one registered blockpage (any
 * OwnerType). PageRegistered logs filtered by owner = topic2 in code.
 * Bounded scan; fail-open → false.
 */
export async function ownsRegisteredPage(wallet: string): Promise<boolean> {
  const want = paddedTopic(wallet).toLowerCase();
  const logs = await fetchRegistryLogs(2);
  return logs.some(
    (l) => l.topics?.[0]?.toLowerCase() === PAGE_REGISTERED_TOPIC0.toLowerCase() && l.topics?.[2]?.toLowerCase() === want,
  );
}

/** True when the wallet owns a page registered as AGENT (OwnerType = 1). */
export async function isAgentWallet(wallet: string): Promise<boolean> {
  const want = paddedTopic(wallet).toLowerCase();
  const logs = await fetchRegistryLogs(2);
  for (const log of logs) {
    if (log.topics?.[0]?.toLowerCase() !== PAGE_REGISTERED_TOPIC0.toLowerCase()) continue;
    if (log.topics?.[2]?.toLowerCase() !== want) continue;
    try {
      const parsed = PAGE_REGISTERED_IFACE.decodeEventLog("PageRegistered", log.data ?? "0x", log.topics ?? []);
      if (Number(parsed.ownerType) === 1) return true;
    } catch {
      /* undecodable log — skip */
    }
  }
  return false;
}

/**
 * 1-based rank of this username among agent pages by registration order,
 * or null when not an agent / unknown. Bounded scan — the first 100
 * agents are long settled by the time the cap matters.
 */
export async function agentPioneerRank(username: string): Promise<number | null> {
  const want = ethers.id(username.toLowerCase());
  const logs = await fetchRegistryLogs(AGENT_SCAN_PAGES);
  const agents: { usernameTopic: string; ts: number }[] = [];
  for (const log of logs) {
    if (log.topics?.[0]?.toLowerCase() !== PAGE_REGISTERED_TOPIC0.toLowerCase()) continue;
    try {
      const parsed = PAGE_REGISTERED_IFACE.decodeEventLog("PageRegistered", log.data ?? "0x", log.topics ?? []);
      const t1 = (log.topics ?? [])[1];
      if (Number(parsed.ownerType) === 1 && t1) {
        const ts = log.timestamp ? Math.floor(Number(log.timestamp) * 1000) : 0;
        agents.push({ usernameTopic: t1.toLowerCase(), ts });
      }
    } catch {
      /* skip */
    }
  }
  agents.sort((a, b) => a.ts - b.ts);
  const idx = agents.findIndex((a) => a.usernameTopic === want.toLowerCase());
  return idx === -1 ? null : idx + 1;
}

/**
 * Count warn/timeout/ban records against a wallet on the forum topic
 * (enforcement lives there). Used for the Clean Record badge.
 */
export async function countViolations(hcs: HcsPort, wallet: string): Promise<number> {
  const topic = getTopicId("forum");
  if (!topic) return 0;
  const canon = canonicalAddress(wallet);
  if (!canon) return 0;
  try {
    const messages = await hcs.queryAll(topic); // served from the 30s HCS cache
    let n = 0;
    for (const m of messages) {
      const c = m.contents as { kind?: string; wallet?: string };
      if ((c.kind === "warn" || c.kind === "timeout" || c.kind === "ban") && c.wallet === canon) n += 1;
    }
    return n;
  } catch {
    return 0; // fail-open: don't block a badge on infra failure
  }
}

/** Wallet that owns a registered username, via the on-chain registry. */
export async function resolveUsernameWallet(username: string): Promise<string | null> {
  try {
    const mod = await import("./registry-check");
    return await mod.defaultRegistryPort().resolveOwner(username);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Public computation                                                 */
/* ------------------------------------------------------------------ */

export interface ComputeBadgesInput {
  username: string;
  /** Optional — unlocks payment/agent/clean-record badges. */
  wallet?: string;
}

export interface ComputeBadgesResult {
  username: string;
  badges: Badge[];
  stats: UserStatsEntry | null;
}

/**
 * Founder bypass for the Builder badge: the founder wallet (0.0.10424063)
 * is treated as having published a blockpage and received a tip, so the
 * Builder badge (and the Builders room) unlock without on-chain activity.
 */
export function applyFounderEnrichment(wallet: string | undefined, enrichment: BadgeEnrichment): void {
  if (wallet && isFounderWallet(wallet)) {
    enrichment.ownsPage = true;
    enrichment.tipsReceived = Math.max(1, enrichment.tipsReceived);
  }
}

/**
 * Badges for one user. HCS-derived signals work with just a username;
 * payment/agent/clean-record badges additionally need the wallet.
 */
export async function computeBadges(hcs: HcsPort, input: ComputeBadgesInput): Promise<ComputeBadgesResult> {
  const username = input.username.trim();
  const key = username.toLowerCase();
  const blob = await getTownhallStats(hcs);
  const entry = blob.users[key] ?? null;

  const canonWallet = input.wallet ? canonicalAddress(input.wallet) : null;
  const wallet = canonWallet && canonWallet !== "0x" ? input.wallet!.trim() : undefined;

  const enrichment: BadgeEnrichment = {
    tipsReceived: 0,
    tipsSent: 0,
    purchasesBought: 0,
    purchasesSold: 0,
    isAgent: false,
    agentRank: null,
    violations: 0,
    ownsPage: false,
  };
  if (wallet) {
    const [logs, agent, violations, ownsPage] = await Promise.all([
      fetchTipsContractLogs(),
      isAgentWallet(wallet),
      countViolations(hcs, wallet),
      ownsRegisteredPage(wallet),
    ]);
    const activity = countWalletActivity(logs, wallet);
    enrichment.tipsReceived = activity.received;
    enrichment.isAgent = agent;
    enrichment.violations = violations;
    enrichment.ownsPage = ownsPage;
    enrichment.tipsSent = activity.sent;
    enrichment.purchasesBought = activity.bought;
    enrichment.purchasesSold = activity.sold;
    if (agent) enrichment.agentRank = await agentPioneerRank(username);
    // Founder bypass: the founder wallet always qualifies for the Builder badge.
    applyFounderEnrichment(wallet, enrichment);
  }

  // Rank among all users by first activity (for Early Adopter).
  const ranked = Object.values(blob.users)
    .filter((u) => u.firstTs > 0)
    .sort((a, b) => a.firstTs - b.firstTs);
  const idx = ranked.findIndex((u) => u.username.toLowerCase() === key);
  const pioneerRank = idx === -1 ? null : idx + 1;

  return { username, badges: badgesForUser(entry ? toStats(entry) : null, enrichment, pioneerRank), stats: entry };
}

/** Rehydrate a cache entry into UserStats for the pure badge function. */
function toStats(u: UserStatsEntry): UserStats {
  return {
    username: u.username,
    chat: u.chat,
    posts: u.posts,
    rooms: u.rooms,
    listings: u.listings,
    positiveVoters: new Set(Array.from({ length: u.positiveVotes }, (_, i) => `voter-${i}`)),
    referrals: new Set(Array.from({ length: u.referrals ?? 0 }, (_, i) => `referred-${i}`)),
    firstTs: u.firstTs || Number.POSITIVE_INFINITY,
    lastTs: u.lastTs,
    activeDays: new Set(Array.from({ length: u.activeDays }, (_, i) => `day-${i}`)),
  };
}

export interface LeaderEntry {
  username: string;
  wallet: string | null;
  score: number;
  badgeCount: number;
  topBadge: Badge | null;
}

/** Top 20 users by activity score. Public, session-less, 5-min cached. */
export async function computeLeaderboard(hcs: HcsPort = defaultHcsPort()): Promise<LeaderEntry[]> {
  const blob = await getTownhallStats(hcs);
  const ranked = Object.values(blob.users)
    .map((u) => ({ u, score: scoreFromEntry(u) }))
    .sort((a, b) => b.score - a.score || a.u.username.localeCompare(b.u.username))
    .slice(0, 20);

  return Promise.all(
    ranked.map(async ({ u, score }) => {
      const badges = badgesForUser(toStats(u), EMPTY_ENRICHMENT, null);
      const wallet = await resolveUsernameWallet(u.username);
      return {
        username: u.username,
        wallet,
        score,
        badgeCount: badges.length,
        topBadge: badges[0] ?? null,
      };
    }),
  );
}
