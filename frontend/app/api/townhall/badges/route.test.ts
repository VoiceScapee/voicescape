/**
 * GET /api/townhall/badges + /api/townhall/leaderboard tests.
 * Both endpoints are public reads: no session, no auth headers required.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/townhall/badges", () => ({
  defaultDepsForBadges: () => ({ hcs: {} }),
  computeBadges: async (_hcs: unknown, input: { username: string; wallet?: string }) => ({
    username: input.username,
    badges: [{ id: "first-words", name: "First Words", description: "d", icon: "💬", category: "activity" }],
    stats: null,
    _wallet: input.wallet ?? null,
  }),
  computeLeaderboard: async () => [
    { username: "alice", wallet: "0xaaa", score: 42, badgeCount: 1, topBadge: null },
  ],
}));

import { GET as badgesGET } from "./route";

function getReq(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

describe("GET /api/townhall/badges", () => {
  it("returns 400 when username is missing", async () => {
    const res = await badgesGET(getReq("http://localhost/api/townhall/badges"));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/username/i);
  });

  it("returns 200 with badges for a username — no session required", async () => {
    // No auth headers at all: the endpoint must still work (public read).
    const res = await badgesGET(getReq("http://localhost/api/townhall/badges?username=alice"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { username: string; badges: { id: string }[] };
    expect(json.username).toBe("alice");
    expect(json.badges[0]!.id).toBe("first-words");
  });

  it("forwards the optional wallet param for payment/agent badges", async () => {
    const res = await badgesGET(
      getReq("http://localhost/api/townhall/badges?username=alice&wallet=0.0.123"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { _wallet: string | null };
    expect(json._wallet).toBe("0.0.123");
  });
});
