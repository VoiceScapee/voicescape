/** Explore ranking tests — pure computation. No network, no chain. */
import { describe, expect, it } from "vitest";
import {
  attachScores,
  badgeCountFor,
  parseExploreSort,
  scorePage,
  sortTrending,
  type TownhallStatsBlob,
} from "./explore-ranking";

function blobWith(users: TownhallStatsBlob["users"]): TownhallStatsBlob {
  return { users, scannedAt: Date.now() };
}

describe("parseExploreSort", () => {
  it("parses new", () => expect(parseExploreSort("new")).toBe("new"));
  it("parses trending", () => expect(parseExploreSort("trending")).toBe("trending"));
  it("falls back to trending on null", () => expect(parseExploreSort(null)).toBe("trending"));
  it("falls back to trending on garbage", () => expect(parseExploreSort("bogus")).toBe("trending"));
});

describe("scorePage", () => {
  it("sums followers and badges", () => {
    expect(scorePage(3, 2)).toBe(5);
    expect(scorePage(0, 0)).toBe(0);
  });
  it("clamps negatives to 0", () => {
    expect(scorePage(-5, 2)).toBe(2);
    expect(scorePage(3, -1)).toBe(3);
  });
});

describe("badgeCountFor", () => {
  const blob = blobWith({
    alice: {
      username: "alice",
      chat: 50, // first-words + chatterbox
      posts: 0,
      rooms: 0,
      listings: 0,
      positiveVotes: 0,
      referrals: 5, // connector + networker
      firstTs: 0,
      lastTs: 0,
      activeDays: 0,
    },
    bob: {
      username: "bob",
      chat: 0,
      posts: 0,
      rooms: 0,
      listings: 0,
      positiveVotes: 0,
      referrals: 0,
      firstTs: 0,
      lastTs: 0,
      activeDays: 0,
    },
  });

  it("counts real earned badges from the blob", () => {
    // alice: first-words, chatterbox, connector, networker = 4.
    // (No phantom "publisher" badge: the badge catalog has no such badge,
    // so owning a page alone grants nothing here.)
    expect(badgeCountFor(blob, "alice")).toBe(4);
  });
  it("is case-insensitive", () => {
    expect(badgeCountFor(blob, "ALICE")).toBe(4);
  });
  it("counts 0 for registered pages with no badge-earning activity", () => {
    expect(badgeCountFor(blob, "bob")).toBe(0);
  });
  it("returns 0 for unknown users", () => {
    expect(badgeCountFor(blob, "nobody")).toBe(0);
  });
  it("returns 0 when the blob is missing", () => {
    expect(badgeCountFor(null, "alice")).toBe(0);
    expect(badgeCountFor(undefined, "alice")).toBe(0);
  });
});

describe("attachScores + sortTrending", () => {
  const pages = [
    { username: "new-page" },
    { username: "popular" },
    { username: "mid" },
  ];
  const signals = (u: string) => {
    if (u === "popular") return { followers: 10, badges: 4 };
    if (u === "mid") return { followers: 2, badges: 1 };
    return { followers: 0, badges: 0 };
  };

  it("attaches followers, badges, and score", () => {
    const scored = attachScores(pages, signals);
    expect(scored.find((p) => p.username === "popular")).toMatchObject({
      followers: 10,
      badges: 4,
      score: 14,
    });
    expect(scored.find((p) => p.username === "new-page")).toMatchObject({
      followers: 0,
      badges: 0,
      score: 0,
    });
  });

  it("sorts by score descending", () => {
    const ranked = sortTrending(attachScores(pages, signals));
    expect(ranked.map((p) => p.username)).toEqual(["popular", "mid", "new-page"]);
  });

  it("breaks ties by input order (recency) — stable sort", () => {
    const tied = [
      { username: "older" },
      { username: "newer" },
    ];
    const ranked = sortTrending(attachScores(tied, () => ({ followers: 1, badges: 1 })));
    expect(ranked.map((p) => p.username)).toEqual(["older", "newer"]);
  });

  it("treats missing signals as zero", () => {
    const ranked = sortTrending(attachScores(pages, () => undefined));
    expect(ranked.map((p) => p.username)).toEqual(["new-page", "popular", "mid"]);
  });
});
