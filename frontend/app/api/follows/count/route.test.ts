/**
 * GET /api/follows/count — public follower counts (no session needed).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { getKvStore } from "@/lib/server/store";
import { followPage, type FollowRegistry } from "@/lib/follows";

const ALICE = "0x1111111111111111111111111111111111111111";
const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const registry: FollowRegistry = {
  resolvePage: async (username: string) =>
    username === "alice" ? { owner: ALICE, ownerType: 0 } : null,
};

import { GET } from "./route";

function countReq(username: string): NextRequest {
  return new NextRequest(`http://localhost/api/follows/count?username=${encodeURIComponent(username)}`, {
    method: "GET",
  });
}

beforeEach(async () => {
  await getKvStore().clearPrefix("follows:");
  await getKvStore().clearPrefix("followers:");
});

describe("GET /api/follows/count", () => {
  it("returns 0 for a page nobody follows", async () => {
    const res = await GET(countReq("alice"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "alice", followers: 0 });
  });

  it("counts distinct wallets without needing a session", async () => {
    // Seed through the real follow core (same store the route reads).
    // The route reads the process-wide store; seed it directly.
    const sharedStore = getKvStore();
    await followPage({ store: sharedStore, wallet: ME, username: "alice", registry });
    await followPage({ store: sharedStore, wallet: OTHER, username: "alice", registry });
    const res = await GET(countReq("alice"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "alice", followers: 2 });
  });

  it("400s on an invalid username", async () => {
    expect((await GET(countReq("!!"))).status).toBe(400);
  });
});
