/**
 * GET /api/follows/digest — chronological digest tests.
 *
 * Mirror node is stubbed (no network); the town-hall post read is mocked;
 * the registry port is faked; the KV store is the real in-memory store.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { SESSION_HEADER } from "@/lib/session-message";
import { getKvStore } from "@/lib/server/store";
import { followPage, type FollowRegistry } from "@/lib/follows";
import { TIPSENT_TOPIC } from "@/lib/leaderboard";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const TIPPER = "0x9999999999999999999999999999999999999999";

vi.mock("@/lib/server/townhall/auth", () => ({
  defaultAuthPort: () => ({
    verifySession: async (cred: unknown) => {
      if (cred === GOOD_TOKEN) {
        return {
          ok: true,
          session: {
            address: ME,
            chainId: 296,
            username: "tester",
            nonce: "n1",
            issuedAtMs: 1_000_000,
            expiresAtMs: 999,
          },
        };
      }
      return { ok: false, error: "missing session: sign in with your wallet" };
    },
  }),
}));

vi.mock("@/lib/server/townhall/registry-check", () => ({
  defaultRegistryPort: () => ({
    isRegistered: async () => true,
    resolveOwner: async () => null,
    resolvePage: async (u: string) =>
      u === "alice"
        ? { owner: ALICE, ownerType: 0 as const }
        : u === "bob"
          ? { owner: BOB, ownerType: 1 as const }
          : null,
  }),
}));

const registry: FollowRegistry = {
  resolvePage: async (u: string) =>
    u === "alice"
      ? { owner: ALICE, ownerType: 0 }
      : u === "bob"
        ? { owner: BOB, ownerType: 1 }
        : null,
};

// Post fixtures (ISO-8601 ts, like the real forum read).
const POST_BOB_TS = "2026-09-13T07:00:05.000Z"; // newest overall
const POST_ALICE_TS = "2026-09-13T06:00:01.000Z"; // oldest overall
vi.mock("@/lib/server/townhall/handlers", () => ({
  defaultDeps: () => ({}),
  getPosts: async () => ({
    status: 200,
    json: {
      posts: [
        { seq: 9, board: "general", wall: null, author: "bob", body: "bob says hi", replyTo: null, ts: POST_BOB_TS },
        { seq: 3, board: "general", wall: null, author: "alice", body: "alice says hi", replyTo: null, ts: POST_ALICE_TS },
        { seq: 2, board: "general", wall: null, author: "stranger", body: "not followed", replyTo: null, ts: POST_ALICE_TS },
      ],
    },
  }),
}));

// Tip fixtures: mirror timestamps are "seconds.nanoseconds".
// alice tip = 06:30, bob tip = 06:10 → order: bob-post, alice-tip, bob-tip, alice-post.
const TIP_ALICE_TS = "1789281000.000000000"; // 2026-09-13T06:30:00Z
const TIP_BOB_TS = "1789279800.000000000"; // 2026-09-13T06:10:00Z

function tipLog(to: string, timestamp: string) {
  const topic = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;
  const amount = (1.5 * 100_000_000).toString(16).padStart(64, "0");
  const fee = (0).toString(16).padStart(64, "0");
  return {
    topics: [TIPSENT_TOPIC, `0x${"0".repeat(64)}`, topic(TIPPER), topic(to)],
    data: `0x${amount}${fee}`,
    timestamp,
    transaction_hash: "0xdeadbeef",
  };
}

const logsByOwner: Record<string, unknown[]> = {
  [ALICE.toLowerCase()]: [tipLog(ALICE, TIP_ALICE_TS)],
  [BOB.toLowerCase()]: [tipLog(BOB, TIP_BOB_TS)],
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    async (url: string) => {
      if (url.includes("/results/logs")) {
        const m = /topic3=(0x[0-9a-f]+)/i.exec(url);
        // topic3 is the 32-byte padded address; the fixtures are keyed by
        // the plain EVM address.
        const owner = `0x${(m?.[1] ?? "").slice(-40).toLowerCase()}`;
        const logs = logsByOwner[owner] ?? [];
        return { ok: true, json: async () => ({ logs }) };
      }
      if (url.includes("/transactions?timestamp=")) {
        return {
          ok: true,
          json: async () => ({ transactions: [{ transaction_id: "0.0.999@1757740200.000000000" }] }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  );
}

const GOOD_TOKEN = "slice5digest.testsig";

import { GET } from "./route";

function digestReq(token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers[SESSION_HEADER] = token;
  return new NextRequest("http://localhost/api/follows/digest", { method: "GET", headers });
}

beforeEach(async () => {
  await getKvStore().clearPrefix("follows:");
  await getKvStore().clearPrefix("followers:");
  stubFetch();
  const store = getKvStore();
  await followPage({ store, wallet: ME, username: "alice", registry });
  await followPage({ store, wallet: ME, username: "bob", registry });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/follows/digest", () => {
  it("401s with no session", async () => {
    const res = await GET(digestReq());
    expect(res.status).toBe(401);
  });

  it("merges tips and posts from all followed pages newest-first", async () => {
    const res = await GET(digestReq(GOOD_TOKEN));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      items: { kind: string; username: string; tsMs: number; ownerType: string }[];
    };
    expect(json.items.map((i) => `${i.kind}:${i.username}`)).toEqual([
      "post:bob",
      "tip:alice",
      "tip:bob",
      "post:alice",
    ]);
    // Strictly descending timestamps.
    const ts = json.items.map((i) => i.tsMs);
    expect([...ts].sort((a, b) => b - a)).toEqual(ts);
    // Human/agent labels survive the digest.
    const bob = json.items.find((i) => i.username === "bob");
    expect(bob?.ownerType).toBe("agent");
    const alice = json.items.find((i) => i.username === "alice");
    expect(alice?.ownerType).toBe("human");
  });

  it("excludes posts by pages the wallet does not follow", async () => {
    const res = await GET(digestReq(GOOD_TOKEN));
    const json = (await res.json()) as { items: { username: string }[] };
    expect(json.items.some((i) => i.username === "stranger")).toBe(false);
  });

  it("links tips to their on-chain transaction", async () => {
    const res = await GET(digestReq(GOOD_TOKEN));
    const json = (await res.json()) as {
      items: { kind: string; txLink: string | null }[];
    };
    const tips = json.items.filter((i) => i.kind === "tip");
    expect(tips.length).toBe(2);
    for (const tip of tips) {
      expect(tip.txLink).toBe("https://hashscan.io/mainnet/transaction/0.0.999@1757740200.000000000");
    }
  });

  it("returns an empty digest when the wallet follows nobody", async () => {
    await getKvStore().clearPrefix("follows:");
    const res = await GET(digestReq(GOOD_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });
});
