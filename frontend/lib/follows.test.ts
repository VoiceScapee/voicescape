/**
 * Slice 5: wallet-signed follows — pure core tests.
 */
import { describe, expect, it } from "vitest";
import { createMemoryKvStore } from "@/lib/server/store";
import {
  followPage,
  followerCount,
  mergeDigestItems,
  padTopicAddress,
  readFollowList,
  unfollowPage,
  type DigestItem,
  type FollowRegistry,
} from "./follows";

const ALICE_OWNER = "0x1111111111111111111111111111111111111111";
const BOB_OWNER = "0x2222222222222222222222222222222222222222";
const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function fakeRegistry(): FollowRegistry {
  const pages: Record<string, { owner: string; ownerType: 0 | 1 }> = {
    alice: { owner: ALICE_OWNER, ownerType: 0 },
    bob: { owner: BOB_OWNER, ownerType: 1 },
    selfpage: { owner: ME, ownerType: 0 },
  };
  return {
    resolvePage: async (username: string) => pages[username] ?? null,
  };
}

describe("followPage", () => {
  it("follows a registered page and returns the list", async () => {
    const store = createMemoryKvStore();
    const res = await followPage({ store, wallet: ME, username: "alice", registry: fakeRegistry() });
    expect(res).toEqual({ ok: true, following: ["alice"] });
  });

  it("dedupes repeat follows", async () => {
    const store = createMemoryKvStore();
    const registry = fakeRegistry();
    await followPage({ store, wallet: ME, username: "alice", registry });
    const res = await followPage({ store, wallet: ME, username: "ALICE", registry });
    expect(res).toEqual({ ok: true, following: ["alice"] });
    expect(await readFollowList(store, ME)).toEqual(["alice"]);
  });

  it("accumulates several follows in order", async () => {
    const store = createMemoryKvStore();
    const registry = fakeRegistry();
    await followPage({ store, wallet: ME, username: "alice", registry });
    const res = await followPage({ store, wallet: ME, username: "bob", registry });
    expect(res).toEqual({ ok: true, following: ["alice", "bob"] });
  });

  it("rejects self-follow", async () => {
    const store = createMemoryKvStore();
    const res = await followPage({ store, wallet: ME, username: "selfpage", registry: fakeRegistry() });
    expect(res).toEqual({ ok: false, error: "self-follow" });
  });

  it("404s on unknown usernames", async () => {
    const store = createMemoryKvStore();
    const res = await followPage({ store, wallet: ME, username: "ghost", registry: fakeRegistry() });
    expect(res).toEqual({ ok: false, error: "unknown-username" });
  });

  it("rejects malformed usernames", async () => {
    const store = createMemoryKvStore();
    const registry = fakeRegistry();
    for (const bad of ["", "ab", "has space", "a".repeat(33), "dot.name"]) {
      const res = await followPage({ store, wallet: ME, username: bad, registry });
      expect(res.ok, bad).toBe(false);
    }
  });
});

describe("unfollowPage", () => {
  it("removes the follow and stays idempotent", async () => {
    const store = createMemoryKvStore();
    const registry = fakeRegistry();
    await followPage({ store, wallet: ME, username: "alice", registry });
    await followPage({ store, wallet: ME, username: "bob", registry });
    expect(await unfollowPage(store, ME, "alice")).toEqual(["bob"]);
    expect(await unfollowPage(store, ME, "alice")).toEqual(["bob"]);
    expect(await readFollowList(store, ME)).toEqual(["bob"]);
  });
});

describe("followerCount", () => {
  it("counts distinct wallets following a page", async () => {
    const store = createMemoryKvStore();
    const registry = fakeRegistry();
    expect(await followerCount(store, "alice")).toBe(0);
    await followPage({ store, wallet: ME, username: "alice", registry });
    await followPage({ store, wallet: BOB_OWNER, username: "alice", registry });
    // Same wallet following twice still counts once.
    await followPage({ store, wallet: ME, username: "alice", registry });
    expect(await followerCount(store, "alice")).toBe(2);
    await unfollowPage(store, ME, "alice");
    expect(await followerCount(store, "alice")).toBe(1);
  });
});

describe("mergeDigestItems", () => {
  function tip(username: string, tsMs: number): DigestItem {
    return {
      kind: "tip",
      username,
      ownerType: "human",
      from: "0x9999999999999999999999999999999999999999",
      amountHbar: 1,
      tsMs,
      txLink: null,
    };
  }
  function post(username: string, tsMs: number): DigestItem {
    return { kind: "post", username, ownerType: "agent", board: "general", body: "hi", tsMs };
  }

  it("merges tips and posts from several pages newest-first", async () => {
    const items = [
      tip("alice", 1000),
      post("bob", 5000),
      tip("bob", 3000),
      post("alice", 2000),
    ];
    const merged = mergeDigestItems(items);
    expect(merged.map((m) => m.tsMs)).toEqual([5000, 3000, 2000, 1000]);
  });

  it("is stable for equal timestamps", () => {
    const a = tip("alice", 1000);
    const b = post("bob", 1000);
    expect(mergeDigestItems([a, b])).toEqual([a, b]);
  });

  it("handles an empty digest", () => {
    expect(mergeDigestItems([])).toEqual([]);
  });
});

describe("padTopicAddress", () => {
  it("pads an EVM address to a 32-byte topic", () => {
    expect(padTopicAddress("0x1111111111111111111111111111111111111111")).toBe(
      "0x0000000000000000000000001111111111111111111111111111111111111111",
    );
  });
  it("rejects non-addresses", () => {
    expect(() => padTopicAddress("0.0.123")).toThrow();
  });
});
