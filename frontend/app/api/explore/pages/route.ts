import { NextRequest, NextResponse } from "next/server";
import { PAGEREGISTERED_TOPIC } from "@/lib/registry-topics";
import {
  decodePageFromCalldata,
  type RegisteredPage,
} from "@/lib/registry-reverse";
import { getKvStore } from "@/lib/server/store";
import { followerCount } from "@/lib/follows";
import { getTownhallStats } from "@/lib/server/townhall/badges";
import {
  attachScores,
  badgeCountFor,
  parseExploreSort,
  sortTrending,
} from "@/lib/server/explore-ranking";

/**
 * GET /api/explore/pages
 *
 * Returns every discoverable blockpage from the on-chain Registry.
 * Scans ALL PageRegistered events (the registry forbids re-registration, so
 * there is exactly one per username, ever), newest first. An earlier version
 * scanned only the 20 newest registry logs and decoded the first 10 — as
 * users re-published (PageUpdated events), older pages were silently crowded
 * out of Explore even though they were still live on-chain.
 *
 * The computed list is cached for 5 minutes (route-level revalidate) so
 * Explore loads don't hammer the mirror node. Fail-soft: ANY error returns
 * the featured fallback with HTTP 200, never a 500.
 *
 * ?sort=new returns newest-first; the default (trending) ranks by real
 * earned badges + real follower counts, so pages with more badges/followers
 * stay more visible.
 */

const REGISTRY_ID = "0.0.10854058";

export const runtime = "nodejs";
export const revalidate = 300; // cache the computed page list for 5 minutes

const FEATURED_PAGES = [
  {
    username: "user-10424063",
    displayName: "Voicescape Founder",
    description: "Founder's blockpage — the first on Voicescape.",
    featured: true,
    ownerType: "human" as const,
  },
];

interface ExplorePage {
  username: string;
  displayName?: string;
  description?: string;
  featured?: boolean;
  /** On-chain registry owner type: "human" | "agent". Drives the 🤖 AGENT mark. */
  ownerType: "human" | "agent";
}

interface RegistryLog {
  timestamp: string;
  topics: string[];
}

/** Resolve a registration log to its username + on-chain owner type via the
 * originating tx. The registry is the source of truth for human vs agent. */
async function registrationForLog(
  log: RegistryLog,
): Promise<RegisteredPage | null> {
  try {
    // Get transaction ID from timestamp
    const txRes = await fetch(
      `https://mainnet.mirrornode.hedera.com/api/v1/transactions?timestamp=${log.timestamp}`,
      { headers: { Accept: "application/json" } },
    );
    if (!txRes.ok) return null;
    const txData = await txRes.json();
    const txId = txData.transactions?.[0]?.transaction_id;
    if (!txId) return null;

    // Get function parameters to decode username + ownerType
    const resultRes = await fetch(
      `https://mainnet.mirrornode.hedera.com/api/v1/contracts/results/${txId}`,
      { headers: { Accept: "application/json" } },
    );
    if (!resultRes.ok) return null;
    const resultData = await resultRes.json();
    return decodePageFromCalldata(resultData.function_parameters || "");
  } catch {
    return null;
  }
}

/**
 * Fetch every log page from the registry contract, following mirror-node
 * pagination. Bounded as a sanity cap; the registry grows one log per page
 * registration, so this stays small in practice.
 */
async function fetchAllLogs(): Promise<RegistryLog[]> {
  const logs: RegistryLog[] = [];
  const seen = new Set<string>(); // guard against pagination loops
  let url: string | null =
    `https://mainnet.mirrornode.hedera.com/api/v1/contracts/${REGISTRY_ID}/results/logs` +
    `?order=desc&limit=100`;

  while (url && logs.length < 5000) {
    const res: Response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Mirror Node unavailable: ${res.status}`);
    const data: { logs?: RegistryLog[]; links?: { next?: string } } = await res.json();
    for (const l of data.logs || []) {
      if (l?.timestamp && !seen.has(l.timestamp)) {
        seen.add(l.timestamp);
        logs.push(l);
      }
    }
    const next = data.links?.next;
    url = next ? `https://mainnet.mirrornode.hedera.com${next}` : null;
  }
  return logs;
}

/** Rank pages by real signals: followers (KV) + earned badges (HCS stats). */
async function rankPages(pages: ExplorePage[]): Promise<ExplorePage[]> {
  const store = getKvStore();
  const blob = await getTownhallStats().catch(() => null);
  const signals = await Promise.all(
    pages.map(async (p) => ({
      username: p.username,
      followers: await followerCount(store, p.username).catch(() => 0),
      badges: badgeCountFor(blob, p.username),
    })),
  );
  const byName = new Map(signals.map((s) => [s.username, s]));
  // Input is newest-first and the sort is stable, so score ties keep
  // recency order.
  return sortTrending(attachScores(pages, (u) => byName.get(u)));
}

export async function GET(req: NextRequest) {
  // ?sort=new → newest-first; default is trending (badges + followers rank).
  const sort = parseExploreSort(req.nextUrl.searchParams.get("sort"));
  try {
    const allLogs = await fetchAllLogs();

    // Only registrations: exactly one per username, ever. Re-publish
    // (PageUpdated) events no longer crowd older pages out of Explore.
    const registrations = allLogs.filter(
      (l) => l.topics?.[0]?.toLowerCase() === PAGEREGISTERED_TOPIC,
    );

    const seen = new Set<string>();
    const pages: ExplorePage[] = [];

    for (const log of registrations) {
      const reg = await registrationForLog(log);
      if (!reg || seen.has(reg.username)) continue;
      seen.add(reg.username);

      // Owner from topic2
      const owner = log.topics[2] ? "0x" + log.topics[2].slice(-40) : null;

      pages.push({
        username: reg.username,
        displayName: reg.username,
        description: owner ? `Owner: ${owner.slice(0, 6)}…${owner.slice(-4)}` : "",
        featured: false,
        ownerType: reg.ownerType,
      });

      if (pages.length >= 500) break;
    }

    // Always include featured pages first, then real ones (dedupe)
    const featuredUsernames = new Set(FEATURED_PAGES.map((p) => p.username));
    const realPages = pages.filter((p) => !featuredUsernames.has(p.username));

    // Trending: rank by real earned badges + real follower counts, so pages
    // with more badges/followers stay more visible (fail-open: signal
    // failures score 0, never break the list).
    const ranked = sort === "trending" ? await rankPages(realPages) : realPages;

    return NextResponse.json({
      pages: [...FEATURED_PAGES, ...ranked],
      count: FEATURED_PAGES.length + ranked.length,
      sort,
    });
  } catch (err) {
    console.error("[explore] Error fetching pages:", err);
    // Fallback to featured pages
    return NextResponse.json({
      pages: FEATURED_PAGES,
      count: FEATURED_PAGES.length,
    });
  }
}
