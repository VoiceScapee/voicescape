/** Badge system tests — pure computation. No network, no chain. */
import { describe, expect, it } from "vitest";
import {
  ALL_BADGES,
  BADGE_BY_ID,
  EMPTY_ENRICHMENT,
  SCORE_WEIGHTS,
  THRESHOLDS,
  TOWNHALL_LAUNCH_TS,
  badgesForUser,
  gatherUserStats,
  scoreFromEntry,
  totalActions,
  type UserStats,
} from "./badges";
import type { StoredMessage, TownhallMessage } from "./types";

let seq = 0;
function msg(
  kind: string,
  author: string,
  extra: Record<string, unknown> = {},
  ts = "2026-09-10T12:00:00Z",
): StoredMessage<TownhallMessage> {
  seq += 1;
  return {
    seq,
    topic: "0.0.1",
    consensusTimestamp: ts,
    contents: { v: 1, kind, author, ts, ...extra } as unknown as TownhallMessage,
  };
}

function statsFor(username: string, patch: Partial<UserStats>): UserStats {
  return {
    username,
    chat: 0,
    posts: 0,
    rooms: 0,
    listings: 0,
    positiveVoters: new Set<string>(),
    referrals: new Set<string>(),
    firstTs: TOWNHALL_LAUNCH_TS,
    lastTs: TOWNHALL_LAUNCH_TS,
    activeDays: new Set<string>(),
    ...patch,
  };
}

describe("badge catalog", () => {
  it("defines 19 badges with unique ids and valid categories", () => {
    expect(ALL_BADGES).toHaveLength(19);
    const ids = ALL_BADGES.map((b) => b.id);
    expect(new Set(ids).size).toBe(19);
    for (const b of ALL_BADGES) {
      expect(["activity", "quality", "milestone", "special"]).toContain(b.category);
      expect(b.name.length).toBeGreaterThan(0);
      expect(b.description.length).toBeGreaterThan(0);
      expect(b.icon.length).toBeGreaterThan(0);
      expect(BADGE_BY_ID[b.id]).toBe(b);
    }
  });

  it("covers all four categories", () => {
    const cats = new Set(ALL_BADGES.map((b) => b.category));
    expect(cats).toEqual(new Set(["activity", "quality", "milestone", "special"]));
  });
});

describe("gatherUserStats", () => {
  it("counts chat messages and room creations per author", () => {
    const lists = {
      forum: [],
      chat: [
        msg("chat", "alice", { room: "lobby", body: "hi" }),
        msg("chat", "alice", { room: "lobby", body: "yo" }),
        msg("chatroom-create", "alice", { id: "r1", title: "R1", description: "" }),
        msg("chat", "bob", { room: "lobby", body: "hey" }),
      ],
      votes: [],
      market: [],
    };
    const map = gatherUserStats(lists);
    expect(map.get("alice")!.chat).toBe(2);
    expect(map.get("alice")!.rooms).toBe(1);
    expect(map.get("bob")!.chat).toBe(1);
    expect(map.get("bob")!.rooms).toBe(0);
  });

  it("counts forum posts", () => {
    const lists = {
      forum: [msg("post", "alice", { board: "general", wall: null, body: "post", replyTo: null })],
      chat: [],
      votes: [],
      market: [],
    };
    expect(gatherUserStats(lists).get("alice")!.posts).toBe(1);
  });

  it("uses latest-per-(voter,target) for rep votes, ignores self-votes and downvotes", () => {
    const lists = {
      forum: [],
      chat: [],
      votes: [
        msg("rep-vote", "carol", { voter: "carol", target: "alice", value: 1 }),
        msg("rep-vote", "dave", { voter: "dave", target: "alice", value: 1 }),
        msg("rep-vote", "dave", { voter: "dave", target: "alice", value: -1 }), // dave changed mind
        msg("rep-vote", "alice", { voter: "alice", target: "alice", value: 1 }), // self-vote
        msg("rep-vote", "erin", { voter: "erin", target: "alice", value: -1 }),
      ],
      market: [],
    };
    const s = gatherUserStats(lists).get("alice")!;
    expect(s.positiveVoters).toEqual(new Set(["carol"]));
  });

  it("uses latest-per-id for listings and skips sold/cancelled", () => {
    const lists = {
      forum: [],
      chat: [],
      votes: [],
      market: [
        msg("listing", "alice", { id: "l1", status: "active", title: "t", description: "d", priceUsdCents: 100, goodsType: "digital", ipfsHash: null, seller: "0x1", sellerUsername: "alice" }),
        msg("listing", "alice", { id: "l1", status: "sold", title: "t", description: "d", priceUsdCents: 100, goodsType: "digital", ipfsHash: null, seller: "0x1", sellerUsername: "alice" }),
        msg("listing", "alice", { id: "l2", status: "active", title: "t", description: "d", priceUsdCents: 100, goodsType: "digital", ipfsHash: null, seller: "0x1", sellerUsername: "alice" }),
      ],
    };
    expect(gatherUserStats(lists).get("alice")!.listings).toBe(1); // only l2
  });

  it("tracks first/last timestamps and active days", () => {
    const lists = {
      forum: [],
      chat: [
        msg("chat", "alice", { room: "lobby", body: "a" }, "2026-09-10T01:00:00Z"),
        msg("chat", "alice", { room: "lobby", body: "b" }, "2026-09-12T01:00:00Z"),
      ],
      votes: [],
      market: [],
    };
    const s = gatherUserStats(lists).get("alice")!;
    expect(s.firstTs).toBe(Date.parse("2026-09-10T01:00:00Z"));
    expect(s.lastTs).toBe(Date.parse("2026-09-12T01:00:00Z"));
    expect(s.activeDays.size).toBe(2);
  });
});

describe("badgesForUser", () => {
  const now = TOWNHALL_LAUNCH_TS + 60 * 24 * 60 * 60 * 1000; // 60 days after launch

  it("awards activity badges at thresholds", () => {
    const s = statsFor("alice", {
      chat: THRESHOLDS.chatterbox,
      posts: THRESHOLDS.forumRegular,
      rooms: THRESHOLDS.roomBuilder,
      listings: THRESHOLDS.marketplaceMogul,
      activeDays: new Set(["2026-09-10"]),
    });
    const ids = badgesForUser(s, EMPTY_ENRICHMENT, 600, now).map((b) => b.id);
    expect(ids).toContain("first-words");
    expect(ids).toContain("chatterbox");
    expect(ids).toContain("forum-regular");
    expect(ids).toContain("room-builder");
    expect(ids).toContain("marketplace-mogul");
    expect(ids).not.toContain("chat-legend");
  });

  it("awards chat-legend at 500 messages", () => {
    const s = statsFor("alice", { chat: THRESHOLDS.chatLegend, activeDays: new Set(["2026-09-10"]) });
    const ids = badgesForUser(s, EMPTY_ENRICHMENT, 600, now).map((b) => b.id);
    expect(ids).toContain("chat-legend");
    expect(ids).toContain("chatterbox");
  });

  it("awards tipped when payments were received", () => {
    const s = statsFor("alice", { activeDays: new Set(["2026-09-10"]) });
    expect(badgesForUser(s, { ...EMPTY_ENRICHMENT, tipsReceived: 1 }, 600, now).map((b) => b.id)).toContain("tipped");
    expect(badgesForUser(s, EMPTY_ENRICHMENT, 600, now).map((b) => b.id)).not.toContain("tipped");
  });

  it("awards community-helper at 5 voters and crowd-favorite at 10", () => {
    const voters = (n: number) => new Set(Array.from({ length: n }, (_, i) => `v${i}`));
    const s5 = statsFor("alice", { positiveVoters: voters(5), activeDays: new Set(["2026-09-10"]) });
    const ids5 = badgesForUser(s5, EMPTY_ENRICHMENT, 600, now).map((b) => b.id);
    expect(ids5).toContain("community-helper");
    expect(ids5).not.toContain("crowd-favorite");
    const s10 = statsFor("alice", { positiveVoters: voters(10), activeDays: new Set(["2026-09-10"]) });
    expect(badgesForUser(s10, EMPTY_ENRICHMENT, 600, now).map((b) => b.id)).toContain("crowd-favorite");
  });

  it("awards clean-record for 30+ days, 50+ actions, zero violations", () => {
    const old = TOWNHALL_LAUNCH_TS; // 60 days before `now`
    const s = statsFor("alice", {
      chat: THRESHOLDS.cleanRecordActions,
      firstTs: old,
      activeDays: new Set(["2026-09-10"]),
    });
    const ok = badgesForUser(s, EMPTY_ENRICHMENT, 600, now).map((b) => b.id);
    expect(ok).toContain("clean-record");
    const withViolation = badgesForUser(s, { ...EMPTY_ENRICHMENT, violations: 1 }, 600, now).map((b) => b.id);
    expect(withViolation).not.toContain("clean-record");
    const young = statsFor("alice", {
      chat: THRESHOLDS.cleanRecordActions,
      firstTs: now - 5 * 24 * 60 * 60 * 1000,
      activeDays: new Set(["2026-11-01"]),
    });
    expect(badgesForUser(young, EMPTY_ENRICHMENT, 600, now).map((b) => b.id)).not.toContain("clean-record");
  });

  it("awards pioneer within the first month, settled-in at 7 days, early-adopter by rank", () => {
    const days = (n: number) => new Set(Array.from({ length: n }, (_, i) => `2026-09-${String(10 + i).padStart(2, "0")}`));
    const s = statsFor("alice", {
      chat: 1,
      firstTs: TOWNHALL_LAUNCH_TS + 5 * 24 * 60 * 60 * 1000,
      activeDays: days(7),
    });
    const ids = badgesForUser(s, EMPTY_ENRICHMENT, 42, now).map((b) => b.id);
    expect(ids).toContain("pioneer");
    expect(ids).toContain("settled-in");
    expect(ids).toContain("early-adopter");

    const late = statsFor("bob", {
      chat: 1,
      firstTs: TOWNHALL_LAUNCH_TS + 60 * 24 * 60 * 60 * 1000,
      activeDays: new Set(["2026-11-09"]),
    });
    const lateIds = badgesForUser(late, EMPTY_ENRICHMENT, 501, now).map((b) => b.id);
    expect(lateIds).not.toContain("pioneer");
    expect(lateIds).not.toContain("settled-in");
    expect(lateIds).not.toContain("early-adopter");
  });

  it("awards agent-pioneer only to agents within the first 100", () => {
    const s = statsFor("agent1", { activeDays: new Set(["2026-09-10"]) });
    const agent = { ...EMPTY_ENRICHMENT, isAgent: true, agentRank: 7 };
    expect(badgesForUser(s, agent, 600, now).map((b) => b.id)).toContain("agent-pioneer");
    const late = { ...EMPTY_ENRICHMENT, isAgent: true, agentRank: 101 };
    expect(badgesForUser(s, late, 600, now).map((b) => b.id)).not.toContain("agent-pioneer");
    expect(badgesForUser(s, EMPTY_ENRICHMENT, 600, now).map((b) => b.id)).not.toContain("agent-pioneer");
  });

  it("awards prolific at 200 total actions", () => {
    const s = statsFor("alice", { chat: 100, posts: 60, rooms: 20, listings: 20, activeDays: new Set(["2026-09-10"]) });
    expect(totalActions(s)).toBe(200);
    expect(badgesForUser(s, EMPTY_ENRICHMENT, 600, now).map((b) => b.id)).toContain("prolific");
    const s2 = statsFor("bob", { chat: 199, activeDays: new Set(["2026-09-10"]) });
    expect(badgesForUser(s2, EMPTY_ENRICHMENT, 600, now).map((b) => b.id)).not.toContain("prolific");
  });

  it("returns no badges for an unknown user", () => {
    expect(badgesForUser(null, EMPTY_ENRICHMENT, null, now)).toEqual([]);
  });

  it("never awards the same badge twice", () => {
    const s = statsFor("alice", { chat: 1000, activeDays: new Set(["2026-09-10"]) });
    const ids = badgesForUser(s, EMPTY_ENRICHMENT, 1, now).map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("scoreFromEntry", () => {
  it("applies the documented weights", () => {
    const score = scoreFromEntry({
      username: "alice",
      chat: 1,
      posts: 1,
      rooms: 1,
      listings: 1,
      positiveVotes: 1,
      referrals: 0,
      firstTs: 1,
      lastTs: 1,
      activeDays: 1,
    });
    expect(score).toBe(
      SCORE_WEIGHTS.chat + SCORE_WEIGHTS.post + SCORE_WEIGHTS.room + SCORE_WEIGHTS.listing + SCORE_WEIGHTS.positiveVote,
    );
  });
});

describe("referral badges", () => {
  it("awards connector at 1 referral, networker at 5", () => {
    const one = statsFor("alice", { referrals: new Set(["bob"]) });
    expect(badgesForUser(one, EMPTY_ENRICHMENT, null).map((b) => b.id)).toContain("connector");
    expect(badgesForUser(one, EMPTY_ENRICHMENT, null).map((b) => b.id)).not.toContain("networker");

    const five = statsFor("alice", { referrals: new Set(["a", "b", "c", "d", "e"]) });
    const ids = badgesForUser(five, EMPTY_ENRICHMENT, null).map((b) => b.id);
    expect(ids).toContain("connector");
    expect(ids).toContain("networker");
    expect(ids).not.toContain("growth-engine");
  });

  it("awards growth-engine at 25 and viral at 100", () => {
    const mk = (n: number) =>
      statsFor("alice", { referrals: new Set(Array.from({ length: n }, (_, i) => `u${i}`)) });
    const ids25 = badgesForUser(mk(25), EMPTY_ENRICHMENT, null).map((b) => b.id);
    expect(ids25).toContain("growth-engine");
    expect(ids25).not.toContain("viral");
    const ids100 = badgesForUser(mk(100), EMPTY_ENRICHMENT, null).map((b) => b.id);
    expect(ids100).toContain("viral");
  });

  it("counts referrals from forum HCS messages, first per referred wins", () => {
    const lists = {
      forum: [
        msg("referral", "alice", { referrer: "brandon", referred: "alice" }),
        msg("referral", "bob", { referrer: "brandon", referred: "bob" }),
        // Duplicate for alice — ignored (first wins).
        msg("referral", "carol", { referrer: "carol", referred: "alice" }),
        // Self-referral — ignored.
        msg("referral", "dave", { referrer: "dave", referred: "dave" }),
      ],
      chat: [],
      votes: [],
      market: [],
    };
    const stats = gatherUserStats(lists);
    expect(stats.get("brandon")?.referrals).toEqual(new Set(["alice", "bob"]));
    expect(stats.get("carol")?.referrals.size ?? 0).toBe(0);
    const ids = badgesForUser(stats.get("brandon") ?? null, EMPTY_ENRICHMENT, null).map((b) => b.id);
    expect(ids).toContain("connector");
  });
});
