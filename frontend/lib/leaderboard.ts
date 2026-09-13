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
  if (!/^\d+\.\d+$/.test(timestamp)) return null;

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
