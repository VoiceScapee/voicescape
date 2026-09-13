/**
 * On-chain market leaderboards: top tippers, top marketplace buyers, and
 * top marketplace sellers.
 *
 * Data comes ONLY from Hedera mirror-node contract logs — no invented
 * numbers, no off-chain estimates:
 * - TipSent(string indexed username, address indexed from, address indexed
 *   toOwner, uint256 amount, uint256 fee) → tippers grouped by `from`
 * - PurchaseCompleted(address indexed buyer, address indexed seller,
 *   string listingRef, uint256 amount, uint256 fee) → buyers by `buyer`,
 *   sellers by `seller`
 *
 * Amounts are decoded from the log data and summed in tinybar, then shown
 * in HBAR. Scans are bounded (10 pages × 100 logs per event type) and the
 * result is cached 10 minutes; every failure mode returns empty boards so
 * the UI can show an honest "no activity yet" state instead of zeros that
 * look measured.
 *
 * Leaderboards show truncated wallet addresses (wallet-only identity — the
 * address IS the identity here, same as on HashScan). No per-blockpage
 * earnings are displayed anywhere; this tab is the only public money
 * surface, and it ranks by on-chain totals only.
 */

import { ethers } from "ethers";
import { getKvStore } from "../store";
import { tinybarToHbar } from "../analytics";
import { mirrorBaseUrl } from "./topics";

export interface MarketLeader {
  /** 0x EVM address of the tipper / buyer / seller. */
  address: string;
  /** Total HBAR moved across the counted events. */
  totalHbar: number;
  /** Number of on-chain events counted. */
  count: number;
}

export interface MarketLeaderboards {
  tippers: MarketLeader[];
  buyers: MarketLeader[];
  sellers: MarketLeader[];
  /** Unix ms when the scan ran (cache transparency). */
  scannedAt: number;
}

export const MARKET_LEADER_LIMIT = 10;
const LEADERS_CACHE_KEY = "vs:market-leaders:v1";
const LEADERS_CACHE_TTL_MS = 10 * 60 * 1000;
const LOG_PAGE_CAP = 10;
const LOG_PAGE_LIMIT = 100;

const TIPSENT_IFACE = new ethers.Interface([
  "event TipSent(string indexed username, address indexed from, address indexed toOwner, uint256 amount, uint256 fee)",
]);
const PURCHASE_IFACE = new ethers.Interface([
  "event PurchaseCompleted(address indexed buyer, address indexed seller, string listingRef, uint256 amount, uint256 fee)",
]);
const TIPSENT_TOPIC0 = TIPSENT_IFACE.getEvent("TipSent")!.topicHash;
const PURCHASE_TOPIC0 = PURCHASE_IFACE.getEvent("PurchaseCompleted")!.topicHash;

function tipsContract(): string | null {
  const a = process.env.NEXT_PUBLIC_TIPS_ADDRESS;
  return a && a.trim() ? a.trim() : null;
}

interface MirrorLog {
  topics?: string[];
  data?: string;
  timestamp?: string;
}

interface MirrorLogsResponse {
  logs?: MirrorLog[];
  links?: { next?: string | null };
}

/**
 * Page through a mirror-node logs list. Bounded by `cap` pages.
 * NOTE (verified 2026-09-13 against mainnet.mirrornode.hedera.com):
 * `topic0..topic3` query filters on /contracts/{id}/results/logs silently
 * return zero logs even for exact topic values. Fetch unfiltered and filter
 * by topic in code instead.
 */
async function fetchLogPages(firstUrl: string, cap: number): Promise<MirrorLog[]> {
  const out: MirrorLog[] = [];
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

/** Last 20 bytes of a 32-byte topic → checksummed-ish 0x address. Null when malformed. */
export function topicToAddress(topic: unknown): string | null {
  if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return ("0x" + topic.slice(-40)).toLowerCase();
}

type AmountDecoder = (log: MirrorLog) => bigint | null;

function tipAmount(log: MirrorLog): bigint | null {
  try {
    const parsed = TIPSENT_IFACE.decodeEventLog("TipSent", log.data ?? "0x", log.topics ?? []);
    return BigInt(parsed.amount.toString());
  } catch {
    return null;
  }
}

function purchaseAmount(log: MirrorLog): bigint | null {
  try {
    const parsed = PURCHASE_IFACE.decodeEventLog("PurchaseCompleted", log.data ?? "0x", log.topics ?? []);
    return BigInt(parsed.amount.toString());
  } catch {
    return null;
  }
}

/**
 * Pure aggregation: group logs by the address in one topic slot, summing
 * decoded amounts. Undecodable logs and malformed addresses are skipped.
 */
export function aggregateByAddress(
  logs: MirrorLog[],
  addressTopicSlot: number,
  decodeAmount: AmountDecoder,
): Map<string, { total: bigint; count: number }> {
  const by = new Map<string, { total: bigint; count: number }>();
  for (const log of logs) {
    const addr = topicToAddress(log.topics?.[addressTopicSlot]);
    const amount = decodeAmount(log);
    if (!addr || amount === null || amount < 0n) continue;
    const cur = by.get(addr) ?? { total: 0n, count: 0 };
    cur.total += amount;
    cur.count += 1;
    by.set(addr, cur);
  }
  return by;
}

/** Rank an aggregate map → top-N leaders, ties broken by address for stability. */
export function rankLeaders(
  by: Map<string, { total: bigint; count: number }>,
  limit: number = MARKET_LEADER_LIMIT,
): MarketLeader[] {
  return [...by.entries()]
    .map(([address, { total, count }]) => ({
      address,
      totalHbar: tinybarToHbar(total),
      count,
    }))
    .sort((a, b) => b.totalHbar - a.totalHbar || (a.address < b.address ? -1 : 1))
    .slice(0, limit);
}

export const EMPTY_BOARDS: MarketLeaderboards = {
  tippers: [],
  buyers: [],
  sellers: [],
  scannedAt: 0,
};

async function computeMarketLeaderboards(): Promise<MarketLeaderboards> {
  const contract = tipsContract();
  if (!contract) return { ...EMPTY_BOARDS, scannedAt: Date.now() };
  const base = `${mirrorBaseUrl()}/api/v1/contracts/${contract}/results/logs`;
  try {
    // NOTE: mirror-node topic query filters silently match nothing on this
    // endpoint, so we fetch the contract's logs unfiltered (bounded pages)
    // and split/filter by topic in code. See docs comment above fetchLogPages.
    const allLogs = await fetchLogPages(
      `${base}?${new URLSearchParams({ order: "asc", limit: String(LOG_PAGE_LIMIT) })}`,
      LOG_PAGE_CAP,
    );
    const tipLogs = allLogs.filter((l) => l.topics?.[0]?.toLowerCase() === TIPSENT_TOPIC0.toLowerCase());
    const purchaseLogs = allLogs.filter((l) => l.topics?.[0]?.toLowerCase() === PURCHASE_TOPIC0.toLowerCase());
    return {
      // TipSent topics: [sig, username, from, toOwner] → tippers = topic2
      tippers: rankLeaders(aggregateByAddress(tipLogs, 2, tipAmount)),
      // PurchaseCompleted topics: [sig, buyer, seller] → buyers = topic1, sellers = topic2
      buyers: rankLeaders(aggregateByAddress(purchaseLogs, 1, purchaseAmount)),
      sellers: rankLeaders(aggregateByAddress(purchaseLogs, 2, purchaseAmount)),
      scannedAt: Date.now(),
    };
  } catch {
    return { ...EMPTY_BOARDS, scannedAt: Date.now() };
  }
}

/** Cached market leaderboards. Fail-open → empty boards (honest empty state). */
export async function getMarketLeaderboards(): Promise<MarketLeaderboards> {
  const kv = getKvStore();
  try {
    const raw = await kv.get(LEADERS_CACHE_KEY);
    if (raw) return JSON.parse(raw) as MarketLeaderboards;
  } catch {
    /* miss / corrupt / backend down → recompute */
  }
  const boards = await computeMarketLeaderboards();
  try {
    await kv.set(LEADERS_CACHE_KEY, JSON.stringify(boards), LEADERS_CACHE_TTL_MS);
  } catch {
    /* fail-open: serve the fresh boards without caching */
  }
  return boards;
}
