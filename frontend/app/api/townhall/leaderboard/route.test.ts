/**
 * GET /api/townhall/leaderboard tests — public read, no auth.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/townhall/badges", () => ({
  defaultDepsForBadges: () => ({ hcs: {} }),
  computeLeaderboard: async () => [
    { username: "alice", wallet: "0xaaa", score: 42, badgeCount: 1, topBadge: null },
    { username: "bob", wallet: null, score: 10, badgeCount: 0, topBadge: null },
  ],
}));

import { GET } from "./route";

describe("GET /api/townhall/leaderboard", () => {
  it("returns 200 with leaders — no session required", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      leaders: { username: string; score: number; badgeCount: number }[];
    };
    expect(json.leaders).toHaveLength(2);
    expect(json.leaders[0]!.username).toBe("alice");
    expect(json.leaders[0]!.score).toBe(42);
  });

  it("works with a bare request (no auth headers)", async () => {
    const req = new NextRequest("http://localhost/api/townhall/leaderboard", { method: "GET" });
    void req;
    const res = await GET();
    expect(res.status).toBe(200);
  });
});
