/**
 * Weekly leaderboard aggregation tests — hermetic fixtures, no network.
 * Covers TipSent log decoding, recipient grouping/summing, unique
 * tipper counting, sort order, and the human-only filter rule.
 */
import { describe, expect, it } from "vitest";
import {
  aggregateWeeklyTips,
  decodeTipSentLog,
  filterHumanCreators,
  TIPSENT_TOPIC,
  type TipEvent,
} from "./leaderboard";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";
const DAVE = "0xdddddddddddddddddddddddddddddddddddddddd";

function topicFor(addr: string): string {
  return "0x" + "0".repeat(24) + addr.slice(2).toLowerCase();
}

function tipLog(opts: {
  from: string;
  to: string;
  amountTinybar: bigint;
  timestamp?: string;
  topic0?: string;
  data?: string;
}) {
  const data =
    opts.data ??
    "0x" + opts.amountTinybar.toString(16).padStart(64, "0") + "0".repeat(64);
  return {
    topics: [
      opts.topic0 ?? TIPSENT_TOPIC,
      "0x" + "0".repeat(64), // usernameHash (unused)
      topicFor(opts.from),
      topicFor(opts.to),
    ],
    data,
    timestamp: opts.timestamp ?? "1757750400.000000000",
  };
}

describe("decodeTipSentLog", () => {
  it("decodes a well-formed TipSent log", () => {
    const log = tipLog({ from: ALICE, to: BOB, amountTinybar: 10_000_000n });
    expect(decodeTipSentLog(log)).toEqual({
      from: ALICE.toLowerCase(),
      to: BOB.toLowerCase(),
      amountHbar: 0.1,
      timestamp: "1757750400.000000000",
    });
  });

  it("rejects non-TipSent events and malformed logs", () => {
    // Wrong event signature (e.g. a PurchaseCompleted log)
    expect(
      decodeTipSentLog(
        tipLog({
          from: ALICE,
          to: BOB,
          amountTinybar: 10_000_000n,
          topic0: "0x" + "ab".repeat(32),
        }),
      ),
    ).toBeNull();
    // Missing topics
    expect(decodeTipSentLog({ data: "0x", timestamp: "1.0" })).toBeNull();
    // Unparseable amount
    expect(
      decodeTipSentLog(tipLog({ from: ALICE, to: BOB, amountTinybar: 0n, data: "0xzzzz" })),
    ).toBeNull();
    // Zero amount is not a real tip
    expect(
      decodeTipSentLog(tipLog({ from: ALICE, to: BOB, amountTinybar: 0n })),
    ).toBeNull();
    // Missing timestamp
    const noTs = tipLog({ from: ALICE, to: BOB, amountTinybar: 10_000_000n });
    delete (noTs as Record<string, unknown>).timestamp;
    expect(decodeTipSentLog(noTs)).toBeNull();
    // Garbage input
    expect(decodeTipSentLog(null)).toBeNull();
    expect(decodeTipSentLog("nope")).toBeNull();
  });
});

describe("aggregateWeeklyTips", () => {
  function events(): TipEvent[] {
    return [
      decodeTipSentLog(tipLog({ from: ALICE, to: BOB, amountTinybar: 100_000_000n }))!,
      decodeTipSentLog(tipLog({ from: CAROL, to: BOB, amountTinybar: 50_000_000n }))!,
      // Same tipper twice → counts once for uniqueTippers, twice for tips
      decodeTipSentLog(tipLog({ from: DAVE, to: ALICE, amountTinybar: 10_000_000n }))!,
      decodeTipSentLog(tipLog({ from: DAVE, to: ALICE, amountTinybar: 10_000_000n }))!,
    ];
  }

  it("groups by recipient, sums HBAR, counts tips and unique tippers", () => {
    const leaders = aggregateWeeklyTips(events());
    expect(leaders).toHaveLength(2);
    const [bob, alice] = leaders;
    expect(bob).toMatchObject({
      recipient: BOB.toLowerCase(),
      totalHbar: 1.5,
      tipCount: 2,
      uniqueTippers: 2,
    });
    expect(alice).toMatchObject({
      recipient: ALICE.toLowerCase(),
      totalHbar: 0.2,
      tipCount: 2,
      uniqueTippers: 1,
    });
  });

  it("sorts descending by total HBAR", () => {
    const leaders = aggregateWeeklyTips(events());
    expect(leaders[0]!.totalHbar).toBeGreaterThanOrEqual(leaders[1]!.totalHbar);
  });

  it("breaks total ties by tip count, deterministically", () => {
    const logs: TipEvent[] = [
      decodeTipSentLog(tipLog({ from: ALICE, to: BOB, amountTinybar: 100_000_000n }))!,
      decodeTipSentLog(tipLog({ from: ALICE, to: CAROL, amountTinybar: 50_000_000n }))!,
      decodeTipSentLog(tipLog({ from: DAVE, to: CAROL, amountTinybar: 50_000_000n }))!,
    ];
    const leaders = aggregateWeeklyTips(logs);
    // Carol and Bob both at 1.0 HBAR; Carol has more tips → Carol first
    expect(leaders[0]!.recipient).toBe(CAROL.toLowerCase());
    expect(leaders[0]!.tipCount).toBe(2);
  });

  it("returns an empty list for no events", () => {
    expect(aggregateWeeklyTips([])).toEqual([]);
  });
});

describe("filterHumanCreators", () => {
  it("excludes known agent pages, keeps humans and unknowns", () => {
    const leaders = [
      { recipient: "0x1", ownerType: "human" as const, totalHbar: 3 },
      { recipient: "0x2", ownerType: "agent" as const, totalHbar: 99 },
      { recipient: "0x3", ownerType: "unknown" as const, totalHbar: 1 },
    ];
    const kept = filterHumanCreators(leaders);
    expect(kept.map((l) => l.recipient)).toEqual(["0x1", "0x3"]);
  });
});
