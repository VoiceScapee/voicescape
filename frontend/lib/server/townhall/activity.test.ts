/**
 * Activity feed tests — hcs.query is stubbed, no network.
 */
import { describe, expect, it, vi } from "vitest";
import { getActivity } from "./activity";
import type { TownhallDeps } from "./handlers";

process.env.TOWNHALL_TOPIC_FORUM = "0.0.7001";
process.env.TOWNHALL_TOPIC_CHAT = "0.0.7002";
process.env.TOWNHALL_TOPIC_GOV = "0.0.7004";
process.env.TOWNHALL_TOPIC_MARKET = "0.0.7005";

interface Canned {
  seq: number;
  contents: Record<string, unknown>;
}

function depsWith(byTopic: Record<string, Canned[]>): TownhallDeps {
  return {
    hcs: {
      query: async (topicId: string) => (byTopic[topicId] ?? []) as never,
    },
  } as unknown as TownhallDeps;
}

const TS = "2026-09-11T15:00:00.000Z";

describe("getActivity", () => {
  it("merges one item per domain, newest first, with deep links", async () => {
    const deps = depsWith({
      "0.0.7001": [
        { seq: 1, contents: { kind: "post", board: "general", wall: null, author: "alice", body: "hello world", ts: TS } },
      ],
      "0.0.7002": [
        { seq: 1, contents: { kind: "chat", room: "lobby", author: "bob", body: "hey", ts: "2026-09-11T15:01:00.000Z" } },
      ],
      "0.0.7004": [
        { seq: 1, contents: { kind: "proposal", id: "p1", title: "More cowbell", author: "carol", ts: "2026-09-11T14:59:00.000Z" } },
        { seq: 2, contents: { kind: "proposal-vote", proposal: "p1", voter: "dave", choice: "yes", ts: "2026-09-11T15:02:00.000Z" } },
      ],
      "0.0.7005": [
        { seq: 1, contents: { kind: "listing", id: "l1", seller: "0xabc", sellerUsername: "erin", title: "Guitar", description: "", priceUsdCents: 5000, goodsType: "physical", ipfsHash: null, status: "active", ts: "2026-09-11T14:58:00.000Z" } },
      ],
    });
    const items = await getActivity(deps);
    expect(items.map((i) => i.kind)).toEqual(["vote", "chat", "post", "proposal", "listing"]);
    expect(items[0]).toMatchObject({ author: "dave", text: "voted yes", href: "/polls" });
    expect(items[1]).toMatchObject({ author: "bob", href: "/chat/lobby" });
    expect(items[2]).toMatchObject({ author: "alice", href: "/forum/general" });
    expect(items[4]).toMatchObject({ author: "erin", href: "/marketplace/l1" });
  });

  it("skips unknown message kinds and survives a dead topic", async () => {
    const deps = depsWith({
      "0.0.7001": [
        { seq: 1, contents: { kind: "mod-action", ts: TS } },
      ],
      "0.0.7002": [],
      "0.0.7004": [],
      "0.0.7005": [],
    });
    // Make the chat topic throw.
    const throwing = depsWith({});
    (throwing.hcs as { query: unknown }).query = async (topicId: string) => {
      if (topicId === "0.0.7002") throw new Error("mirror down");
      return [];
    };
    expect(await getActivity(deps)).toEqual([]);
    expect(await getActivity(throwing)).toEqual([]);
  });

  it("clips long bodies", async () => {
    const deps = depsWith({
      "0.0.7001": [
        { seq: 1, contents: { kind: "post", board: "general", wall: null, author: "alice", body: "x".repeat(200), ts: TS } },
      ],
      "0.0.7002": [],
      "0.0.7004": [],
      "0.0.7005": [],
    });
    const items = await getActivity(deps);
    expect(items).toHaveLength(1);
    expect(items[0].text.length).toBeLessThan(100);
    expect(items[0].text.endsWith("…")).toBe(true);
  });

  it("uses vi to assert the query contract", async () => {
    const query = vi.fn(async (_topic: string, _opts: { limit: number }) => []);
    const deps = { hcs: { query } } as unknown as TownhallDeps;
    await getActivity(deps);
    // One bounded read per configured topic.
    expect(query).toHaveBeenCalledTimes(4);
    for (const call of query.mock.calls) {
      expect(call[1]).toMatchObject({ limit: 6 });
    }
  });
});
