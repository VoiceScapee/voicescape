/**
 * Weekly leaderboard aggregation: pure functions over Hedera Mirror Node
 * TipSent event logs. No network here — the API route fetches logs and
 * resolves usernames; this module only decodes and aggregates so the logic
 * is unit-testable with fixtures.
 *
 * TipSent event signature: TipSent(string,address,address,uint256,uint256)
 * Topics: [signature, usernameHash, from, toOwner]
 * Data: amount (uint256, tinybar), fee (uint256, tinybar)
 */

/** TipSent(string,address,address,uint256,uint256) event signature. */
export const TIPSENT_TOPIC =
  "0xddb557901a5c7e767f2276c1190ca61ae148d62a74cfa61e4f7fa5319eaa431e";

/** 1 HBAR = 100,000,000 tinybar. */
const TINYBAR_PER_HBAR = 100_000_000;

export interface TipEvent {
  /** Tipper's EVM address (lowercased). */
  from: string;
  /** Recipient page owner's EVM address (lowercased). */
  to: string;
  /** Tip amount in HBAR (the creator's 98% share — what the event records). */
  amountHbar: number;
  /** Mirror-node timestamp of the log ("seconds.nanoseconds"). */
  timestamp: string;
}

export interface WeeklyLeader {
  /** Recipient page owner's EVM address (lowercased). */
  recipient: string;
  /** Total HBAR received in the window. */
  totalHbar: number;
  /** Number of tips received. */
  tipCount: number;
  /** Number of distinct tippers. */
  uniqueTippers: number;
}

/**
 * Decode one mirror-node log into a TipEvent. Returns null for anything
 * that is not a well-formed TipSent event (wrong topic, missing parties,
 * unparseable amount) — callers skip nulls.
 */
export function decodeTipSentLog(log: unknown): TipEvent | null {
  if (!log || typeof log !== "object") return null;
  const l = log as {
    topics?: unknown;
    data?: unknown;
    timestamp?: unknown;
  };
  const topics = Array.isArray(l.topics) ? (l.topics as unknown[]) : null;
  if (!topics || typeof topics[0] !== "string") return null;
  if ((topics[0] as string).toLowerCase() !== TIPSENT_TOPIC) return null;

  const fromTopic = topics[2];
  const toTopic = topics[3];
  if (typeof fromTopic !== "string" || typeof toTopic !== "string") return null;
  const from = "0x" + fromTopic.slice(-40).toLowerCase();
  const to = "0x" + toTopic.slice(-40).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(from) || !/^0x[0-9a-f]{40}$/.test(to)) return null;

  let amountHbar = 0;
  if (typeof l.data === "string" && l.data.length >= 66) {
    try {
      const amountTinybar = BigInt("0x" + l.data.slice(2, 66));
      amountHbar = Number(amountTinybar) / TINYBAR_PER_HBAR;
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (!Number.isFinite(amountHbar) || amountHbar <= 0) return null;

  const timestamp = typeof l.timestamp === "string" ? l.timestamp : "";
  // The per-transaction contract-results endpoint omits the timestamp
  // field that the contract-logs endpoint provides. Verification only
  // needs the parties and amount — accept a missing timestamp rather
  // than rejecting every log from that endpoint.
  if (timestamp && !/^\d+\.\d+$/.test(timestamp)) return null;

  return { from, to, amountHbar, timestamp };
}

/**
 * Group tip events by recipient, summing HBAR, counting tips and unique
 * tippers. Sorted descending by total HBAR (ties broken by tip count,
 * then by recipient address for determinism).
 */
export function aggregateWeeklyTips(events: TipEvent[]): WeeklyLeader[] {
  const byRecipient = new Map<string, { totalHbar: number; tipCount: number; tippers: Set<string> }>();

  for (const e of events) {
    const existing = byRecipient.get(e.to) ?? { totalHbar: 0, tipCount: 0, tippers: new Set<string>() };
    existing.totalHbar += e.amountHbar;
    existing.tipCount += 1;
    existing.tippers.add(e.from);
    byRecipient.set(e.to, existing);
  }

  return Array.from(byRecipient.entries())
    .map(([recipient, stats]) => ({
      recipient,
      totalHbar: stats.totalHbar,
      tipCount: stats.tipCount,
      uniqueTippers: stats.tippers.size,
    }))
    .sort((a, b) => {
      if (b.totalHbar !== a.totalHbar) return b.totalHbar - a.totalHbar;
      if (b.tipCount !== a.tipCount) return b.tipCount - a.tipCount;
      return a.recipient.localeCompare(b.recipient);
    });
}

/**
 * Per-creator earnings summary over decoded TipEvent streams.
 */
export interface EarningsSummary {
  /** HBAR received in the last 7 days. */
  hbar7d: number;
  /** HBAR received in the last 30 days. */
  hbar30d: number;
  /** HBAR received across all fetched events (see truncation flag). */
  hbarAllTime: number;
  /** Number of tips received in the last 7 days. */
  tipCount7d: number;
  /** Number of tips received in the last 30 days. */
  tipCount30d: number;
  /** Distinct tipper addresses in the last 30 days. */
  uniqueTippers30d: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Sum tip windows for one recipient address. Window boundaries are
 * inclusive of events at exactly the cutoff (>= cutoff). Events are
 * already expected to be filtered to TipSent (decodeTipSentLog); events
 * not addressed to `address` are ignored here so the caller can aggregate
 * over a raw mixed stream.
 */
export function aggregateEarnings(
  events: TipEvent[],
  address: string,
  nowMs: number = Date.now(),
): EarningsSummary {
  const owner = address.toLowerCase();
  const cut7 = nowMs - 7 * MS_PER_DAY;
  const cut30 = nowMs - 30 * MS_PER_DAY;
  const summary: EarningsSummary = {
    hbar7d: 0,
    hbar30d: 0,
    hbarAllTime: 0,
    tipCount7d: 0,
    tipCount30d: 0,
    uniqueTippers30d: 0,
  };
  const tippers = new Set<string>();
  for (const e of events) {
    if (e.to.toLowerCase() !== owner) continue;
    const sec = Number(e.timestamp.split(".")[0]);
    if (!Number.isFinite(sec)) continue;
    const ms = sec * 1000;
    summary.hbarAllTime += e.amountHbar;
    if (ms >= cut30) {
      summary.hbar30d += e.amountHbar;
      summary.tipCount30d += 1;
      tippers.add(e.from);
      if (ms >= cut7) {
        summary.hbar7d += e.amountHbar;
        summary.tipCount7d += 1;
      }
    }
  }
  summary.uniqueTippers30d = tippers.size;
  return summary;
}

/**
 * Human-filter rule for the leaderboard. The on-chain Registry is the
 * source of truth for whether a page is human or agent (registerPage's
 * ownerType: 0 = HUMAN, 1 = AGENT). Known agent pages are excluded.
 * Recipients whose page can't be resolved (null) are INCLUDED — we can't
 * prove they're agents, and excluding them would hide real creators.
 */
export function filterHumanCreators<T extends { ownerType: "human" | "agent" | "unknown" }>(
  leaders: T[],
): T[] {
  return leaders.filter((l) => l.ownerType !== "agent");
}
