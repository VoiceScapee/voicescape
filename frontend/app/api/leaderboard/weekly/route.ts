import { NextResponse } from "next/server";
import {
  aggregateWeeklyTips,
  decodeTipSentLog,
  filterHumanCreators,
} from "@/lib/leaderboard";
import { resolvePageForOwner } from "@/lib/registry-reverse";

/**
 * GET /api/leaderboard/weekly
 *
 * Weekly top-tipped creators leaderboard. Aggregates TipSent event logs
 * from the last 7 days on the VoicescapeTips contract (official Hedera
 * Mirror Node only — no contract redeployment, no funds movement).
 *
 * Human-filter rule: the on-chain Registry is the source of truth for
 * human vs agent (registerPage ownerType: 0 = HUMAN, 1 = AGENT). Known
 * agent pages are excluded from the leaderboard; recipients whose page
 * can't be resolved are included (ownerType "unknown") — we can't prove
 * they're agents, and excluding them would hide real creators.
 *
 * Response: { leaders: [{ rank, recipient, username, ownerType,
 *             totalHbar, tipCount, uniqueTippers }], windowDays }
 * On mirror-node failure: { leaders: [], error } — never throws.
 */

const TIPS_CONTRACT = "0.0.10854060";
const MIRROR_NODE = "https://mainnet.mirrornode.hedera.com/api/v1";
const WINDOW_DAYS = 7;
/** Mirror pagination: 100 logs/page, capped so one request stays cheap. */
const LOGS_PER_PAGE = 100;
const MAX_LOG_PAGES = 5;
const MAX_LEADERS = 20;

/**
 * Fetch TipSent logs from the last 7 days, newest first, following
 * mirror-node pagination (bounded). Returns raw logs; empty on failure —
 * the caller surfaces the error as { leaders: [], error }.
 */
async function fetchWeeklyTipLogs(): Promise<unknown[]> {
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 24 * 60 * 60;
  let url =
    `${MIRROR_NODE}/contracts/${TIPS_CONTRACT}/results/logs` +
    `?order=desc&limit=${LOGS_PER_PAGE}&timestamp=gte:${sevenDaysAgo}.000000000`;

  const allLogs: unknown[] = [];
  for (let page = 0; page < MAX_LOG_PAGES && url; page++) {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      next: { revalidate: 300 }, // Cache for 5 minutes — cheap and fresh enough.
    });
    if (!res.ok) throw new Error(`Mirror Node returned ${res.status}`);
    const data = (await res.json()) as { logs?: unknown[]; links?: { next?: string | null } };
    const logs = Array.isArray(data.logs) ? data.logs : [];
    allLogs.push(...logs);
    const next = data.links?.next ?? null;
    url = next ? (next.startsWith("http") ? next : `${MIRROR_NODE}${next}`) : "";
  }
  return allLogs;
}

export async function GET() {
  try {
    const logs = await fetchWeeklyTipLogs();
    const events = logs
      .map(decodeTipSentLog)
      .filter((e): e is NonNullable<typeof e> => e !== null);

    const aggregated = aggregateWeeklyTips(events);

    // Resolve each recipient's page (username + on-chain owner type) and
    // apply the human-only filter before ranking/slicing.
    const resolved = await Promise.all(
      aggregated.map(async (leader) => {
        const page = await resolvePageForOwner(leader.recipient);
        return {
          ...leader,
          username: page?.username ?? null,
          ownerType: (page?.ownerType ?? "unknown") as "human" | "agent" | "unknown",
        };
      }),
    );

    const leaders = filterHumanCreators(resolved)
      .slice(0, MAX_LEADERS)
      .map((l, i) => ({
        rank: i + 1,
        recipient: l.recipient,
        username: l.username,
        ownerType: l.ownerType,
        totalHbar: l.totalHbar.toFixed(4),
        tipCount: l.tipCount,
        uniqueTippers: l.uniqueTippers,
      }));

    return NextResponse.json({ leaders, windowDays: WINDOW_DAYS });
  } catch (err) {
    console.error("[leaderboard] Error fetching weekly leaderboard:", err);
    return NextResponse.json({ leaders: [], error: "Failed to load leaderboard" });
  }
}
