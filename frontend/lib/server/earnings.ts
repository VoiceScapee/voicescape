/**
 * Creator earnings — server-side mirror-node reads (Hedera mainnet only).
 *
 * Reads TipSent logs for the Tips contract and sums them for one recipient
 * wallet. Pure reads: no contract calls, no funds movement, no redeployment.
 *
 * NOTE (verified 2026-09-13, see lib/server/analytics.ts): mirror-node
 * topic query filters silently match nothing on
 * /contracts/{id}/results/logs, so we fetch the contract's TipSent logs
 * unfiltered (bounded pagination) and filter by topic0 + recipient topic
 * in code. The decoding/aggregation itself reuses lib/leaderboard.ts so the
 * numbers match the public leaderboard exactly.
 */
import { aggregateEarnings, decodeTipSentLog, type EarningsSummary } from "../leaderboard";

/** On-chain Tips contract (Sourcify-verified, treasury 0.0.10424063). */
const TIPS_CONTRACT = "0.0.10854060";
const MIRROR_NODE = "https://mainnet.mirrornode.hedera.com/api/v1";
/** Mirror pagination: 100 logs/page, capped so one request stays cheap. */
const LOGS_PER_PAGE = 100;
const MAX_LOG_PAGES = 5;

export interface EarningsResult {
  ok: true;
  /** The recipient address (lowercased EVM). */
  address: string;
  summary: EarningsSummary;
  /**
   * True when pagination hit the page cap with more logs available — the
   * all-time totals may undercount. Current tip volume is far below the
   * cap (500 logs), so this is effectively exact.
   */
  allTimeTruncated: boolean;
}

export interface EarningsFailure {
  ok: false;
  error: string;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Fetch one recipient's tip summary from the mirror node. Never throws —
 * every failure mode returns { ok: false, error } so the API route answers
 * gracefully. `fetcher` is injectable for tests; `nowMs` pins the windows.
 */
export async function fetchEarningsSummary(
  address: string,
  opts?: { fetcher?: Fetcher; nowMs?: number },
): Promise<EarningsResult | EarningsFailure> {
  const owner = address.toLowerCase();
  const nowMs = opts?.nowMs ?? Date.now();
  const fetcher: Fetcher = opts?.fetcher ?? fetch;

  const firstUrl =
    `${MIRROR_NODE}/contracts/${TIPS_CONTRACT}/results/logs` +
    `?order=desc&limit=${LOGS_PER_PAGE}`;

  let allTimeTruncated = false;
  try {
    const logs: unknown[] = [];
    let url: string | null = firstUrl;
    for (let page = 0; page < MAX_LOG_PAGES && url; page++) {
      const res = await fetcher(url, {
        headers: { Accept: "application/json" },
        next: { revalidate: 300 },
      });
      if (!res.ok) throw new Error(`mirror node returned ${res.status}`);
      const data = (await res.json()) as { logs?: unknown[]; links?: { next?: string | null } };
      const pageLogs = Array.isArray(data.logs) ? data.logs : [];
      logs.push(...pageLogs);
      const next = data.links?.next ?? null;
      url = next ? (next.startsWith("http") ? next : `${MIRROR_NODE}${next}`) : null;
      if (page === MAX_LOG_PAGES - 1 && url) allTimeTruncated = true;
    }

    const events = logs
      .map(decodeTipSentLog)
      .filter((e): e is NonNullable<typeof e> => e !== null)
      // The fetch is unfiltered (topic filters silently match nothing on
      // this endpoint), so the recipient match happens in code: decode
      // takes topic3 (toOwner) as the event's `to`.
      .filter((e) => e.to === owner);

    return {
      ok: true,
      address: owner,
      summary: aggregateEarnings(events, owner, nowMs),
      allTimeTruncated,
    };
  } catch (err) {
    return { ok: false, error: "earnings data is unavailable right now" };
  }
}
