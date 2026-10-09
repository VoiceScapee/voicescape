/**
 * Voicescape MCP P2/P3 parity tools — unit tests.
 *
 * Every network call is driven by fixtures; the real network is never
 * touched. On-chain reads (Registry resolvePage, mirror node) are faked
 * per-test so agent/target identities resolve deterministically.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ethers } from "ethers";
import {
  listMarketplaceTool,
  preparePurchaseTool,
  prepareTipTool,
  followCreatorTool,
  unfollowCreatorTool,
  postHireReviewTool,
  createFundraiserTool,
  manageMusicTool,
} from "./mcp-tools-misc";
import { TIPS_ABI } from "../tx";
import { createMemoryKvStore, resetKvStoreSingleton } from "./store";
import type { TownhallDeps } from "./townhall/handlers";
import type { GoalDeps } from "./goals";

type RouteHandler = (url: string, init?: RequestInit) => unknown;

function mockFetch(routes: Array<[RegExp, RouteHandler | { status: number; body: unknown }]>): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = String(input);
    for (const [re, handler] of routes) {
      if (re.test(url)) {
        const out: { status: number; body: unknown } =
          typeof handler === "function" ? (handler(url, init) as { status: number; body: unknown }) : handler;
        return {
          ok: out.status >= 200 && out.status < 300,
          status: out.status,
          json: async () => out.body,
        } as Response;
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const ok = (body: unknown) => ({ status: 200, body });

/* ------------------------- registry fixtures ------------------------- */

const RESOLVE_IFACE = new ethers.Interface([
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
]);

function resolvePageResult(owner: string, ipfsHash = ""): string {
  return RESOLVE_IFACE.encodeFunctionResult("resolvePage", [
    owner,
    ipfsHash,
    1n,
    "0x0000000000000000000000000000000000000000",
    "test agent",
  ]);
}

const OWNER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OWNER_C = "0xcccccccccccccccccccccccccccccccccccccccc";
const PAGE_CID = "Qm" + "1".repeat(44);

/**
 * Registry fixture routing /contracts/call by the ABI-encoded username in
 * the POST body. `pages` maps username → { owner, ipfsHash }.
 */
function registryFetch(pages: Record<string, { owner: string; ipfsHash?: string }>): typeof fetch {
  return mockFetch([
    [
      /contracts\/call$/,
      (url, init) => {
        const body = String((init as { body?: unknown } | undefined)?.body ?? "");
        for (const [name, p] of Object.entries(pages)) {
          if (body.includes(Buffer.from(name, "utf-8").toString("hex"))) {
            return ok({ result: resolvePageResult(p.owner, p.ipfsHash ?? "") });
          }
        }
        return ok({ result: "0x" }); // reverts → unknown name
      },
    ],
    [/accounts\/0x/, () => ok({ account: "0.0.99999" })],
  ]);
}

beforeEach(() => {
  resetKvStoreSingleton();
  vi.unstubAllEnvs();
});

/* ------------------------- list_marketplace ------------------------- */

function listingMessage(over: Record<string, unknown> = {}) {
  return {
    seq: 1,
    topic: "0.0.555",
    consensusTimestamp: "2026-10-07T00:00:00.000Z",
    contents: {
      kind: "listing",
      id: "badge-1",
      seller: OWNER_B,
      sellerUsername: "creator-bob",
      title: "Bacon Badge",
      description: "A tasty badge",
      priceUsdCents: 100,
      goodsType: "digital",
      ipfsHash: null,
      status: "active",
      ts: "2026-10-07T00:00:00.000Z",
      ...over,
    },
  };
}

function marketDeps(messages: unknown[]): TownhallDeps {
  return {
    hcs: { queryAll: async () => messages },
  } as unknown as TownhallDeps;
}

describe("list_marketplace", () => {
  beforeEach(() => {
    vi.stubEnv("TOWNHALL_TOPIC_MARKET", "0.0.555");
  });

  it("returns active listings with filters", async () => {
    const res = (await listMarketplaceTool(
      { q: "bacon", category: "digital", min_price_cents: 50, max_price_cents: 500 },
      marketDeps([listingMessage(), listingMessage({ id: "other", status: "sold" })]),
    )) as { listings: { id: string }[]; count: number };
    expect(res.count).toBe(1);
    expect(res.listings[0].id).toBe("badge-1");
  });

  it("filters by free text and excludes non-matching", async () => {
    const res = (await listMarketplaceTool(
      { q: "nope" },
      marketDeps([listingMessage()]),
    )) as { listings: unknown[]; count: number };
    expect(res.count).toBe(0);
    expect(res.listings).toEqual([]);
  });

  it("sorts price-desc", async () => {
    const res = (await listMarketplaceTool(
      { sort: "price-desc" },
      marketDeps([
        listingMessage({ id: "cheap", priceUsdCents: 50 }),
        listingMessage({ id: "dear", priceUsdCents: 900 }),
      ]),
    )) as { listings: { id: string }[] };
    expect(res.listings.map((l) => l.id)).toEqual(["dear", "cheap"]);
  });

  it("rejects a bad category", async () => {
    const res = await listMarketplaceTool({ category: "nft" }, marketDeps([]));
    expect("error" in res).toBe(true);
  });

  it("errors when the market topic is unconfigured", async () => {
    vi.stubEnv("TOWNHALL_TOPIC_MARKET", "");
    const res = await listMarketplaceTool({}, marketDeps([listingMessage()]));
    expect("error" in res).toBe(true);
  });
});

/* ------------------------- prepare_purchase ------------------------- */

const BUY_IFACE = new ethers.Interface(TIPS_ABI);

function purchaseDeps(listing: Record<string, unknown>) {
  return marketDeps([
    {
      seq: 1,
      topic: "0.0.555",
      consensusTimestamp: "2026-10-07T00:00:00.000Z",
      contents: { kind: "listing", ...listing },
    },
  ]);
}

const ACTIVE_LISTING = {
  id: "badge-1",
  seller: OWNER_B,
  sellerUsername: "creator-bob",
  title: "Bacon Badge",
  description: "A tasty badge",
  priceUsdCents: 100,
  goodsType: "digital",
  ipfsHash: null,
  status: "active",
  ts: "2026-10-07T00:00:00.000Z",
};

function priceFetch() {
  return mockFetch([
    [/network\/exchangerate$/, () => ok({ current_rate: { cent_equivalent: 20, hbar_equivalent: 100 } })],
  ]);
}

describe("prepare_purchase", () => {
  beforeEach(() => {
    vi.stubEnv("TOWNHALL_TOPIC_MARKET", "0.0.555");
  });

  it("builds unsigned buyListing calldata with the HBAR value", async () => {
    const res = (await preparePurchaseTool(
      { listing_id: "badge-1" },
      purchaseDeps(ACTIVE_LISTING),
      priceFetch(),
    )) as {
      unsigned_calldata: string;
      function_selector: string;
      value_tinybar: string;
      value_hbar: string;
      contract: string;
      instructions: string;
    };
    expect(res.contract).toBe("0.0.10854060");
    // $1.00 at $0.002/HBAR → 500 HBAR = 50_000_000_000 tinybar
    expect(res.value_tinybar).toBe("50000000000");
    expect(res.value_hbar).toBe("500.00000000");
    const decoded = BUY_IFACE.decodeFunctionData("buyListing", res.unsigned_calldata);
    expect((decoded[0] as string).toLowerCase()).toBe(OWNER_B);
    expect(decoded[1]).toBe("badge-1");
    expect(res.function_selector).toBe(BUY_IFACE.getFunction("buyListing")!.selector);
    expect(res.instructions).toMatch(/UNSIGNED/);
    expect(res.instructions).toMatch(/YOUR OWN Hedera key/);
  });

  it("converts a 0.0.x seller to long-zero EVM form", async () => {
    const res = (await preparePurchaseTool(
      { listing_id: "badge-1" },
      purchaseDeps({ ...ACTIVE_LISTING, seller: "0.0.123", sellerUsername: null }),
      priceFetch(),
    )) as { unsigned_calldata: string };
    const decoded = BUY_IFACE.decodeFunctionData("buyListing", res.unsigned_calldata);
    expect((decoded[0] as string).toLowerCase()).toBe(
      "0x" + BigInt(123).toString(16).padStart(40, "0"),
    );
  });

  it("errors on an unknown listing", async () => {
    const res = await preparePurchaseTool({ listing_id: "nope" }, purchaseDeps(ACTIVE_LISTING), priceFetch());
    expect("error" in res).toBe(true);
  });

  it("refuses non-active listings", async () => {
    const res = await preparePurchaseTool(
      { listing_id: "badge-1" },
      purchaseDeps({ ...ACTIVE_LISTING, status: "sold" }),
      priceFetch(),
    );
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/not for sale/);
  });

  it("errors when the HBAR price is unreadable", async () => {
    const bad = mockFetch([[/network\/exchangerate$/, () => ({ status: 500, body: null })]]);
    const res = await preparePurchaseTool({ listing_id: "badge-1" }, purchaseDeps(ACTIVE_LISTING), bad);
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/HBAR\/USD/);
  });
});

/* ------------------------- prepare_tip ------------------------- */

const TIP_PAGES = {
  "creator-bob": { owner: OWNER_B },
};

describe("prepare_tip", () => {
  const TIP_IFACE = new ethers.Interface(TIPS_ABI);

  it("builds unsigned tipPage calldata with the HBAR value and 98/2 preview", async () => {
    const res = (await prepareTipTool(
      { recipient: "creator-bob", amount_hbar: "1" },
      registryFetch(TIP_PAGES),
    )) as {
      unsigned_calldata: string;
      function_selector: string;
      value_tinybar: string;
      value_hbar: string;
      creator_net_hbar: string;
      treasury_fee_hbar: string;
      contract: string;
      function: string;
      recipient: { username: string };
      instructions: string;
    };
    expect(res.contract).toBe("0.0.10854060");
    expect(res.function).toBe("tipPage(string username)");
    expect(res.value_tinybar).toBe("100000000");
    expect(res.value_hbar).toBe("1");
    // 98/2 split preview: 1 HBAR -> 0.98 creator, 0.02 treasury
    expect(res.creator_net_hbar).toBe("0.98");
    expect(res.treasury_fee_hbar).toBe("0.02");
    const decoded = TIP_IFACE.decodeFunctionData("tipPage", res.unsigned_calldata);
    expect(decoded[0]).toBe("creator-bob");
    expect(res.function_selector).toBe(TIP_IFACE.getFunction("tipPage")!.selector);
    expect(res.recipient.username).toBe("creator-bob");
    expect(res.instructions).toMatch(/UNSIGNED/);
    expect(res.instructions).toMatch(/YOUR OWN Hedera key/);
    expect(res.instructions).toMatch(/verify_tip/);
  });

  it("handles fractional amounts with exact tinybar math", async () => {
    const res = (await prepareTipTool(
      { recipient: "creator-bob", amount_hbar: "0.5" },
      registryFetch(TIP_PAGES),
    )) as { value_tinybar: string; creator_net_hbar: string; treasury_fee_hbar: string };
    expect(res.value_tinybar).toBe("50000000");
    expect(res.creator_net_hbar).toBe("0.49");
    expect(res.treasury_fee_hbar).toBe("0.01");
  });

  it("errors on an unregistered blockpage", async () => {
    const res = await prepareTipTool(
      { recipient: "ghost-page", amount_hbar: "1" },
      registryFetch(TIP_PAGES),
    );
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/not registered/);
  });

  it("rejects a 0.0.x account id — tipPage takes a username", async () => {
    const res = await prepareTipTool(
      { recipient: "0.0.12345", amount_hbar: "1" },
      registryFetch(TIP_PAGES),
    );
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/not a valid blockpage username/);
  });

  it("rejects invalid and zero amounts", async () => {
    for (const amount_hbar of ["abc", "0", "-1", ""]) {
      const res = await prepareTipTool(
        { recipient: "creator-bob", amount_hbar },
        registryFetch(TIP_PAGES),
      );
      expect("error" in res).toBe(true);
      expect((res as { error: string }).error).toMatch(/not a positive HBAR amount/);
    }
  });
});

/* ------------------------- follow_creator / unfollow_creator ------------------------- */

const FOLLOW_PAGES = {
  "agent-one": { owner: OWNER_A },
  "creator-bob": { owner: OWNER_B },
};

describe("follow_creator", () => {
  it("follows a registered page as the agent's owner wallet", async () => {
    const store = createMemoryKvStore();
    const res = (await followCreatorTool(
      { agent_username: "agent-one", target_username: "creator-bob" },
      { fetchFn: registryFetch(FOLLOW_PAGES), store },
    )) as { ok: boolean; following: string[] };
    expect(res.ok).toBe(true);
    expect(res.following).toContain("creator-bob");
  });

  it("rejects an unregistered agent identity", async () => {
    const res = await followCreatorTool(
      { agent_username: "ghost-agent", target_username: "creator-bob" },
      { fetchFn: registryFetch(FOLLOW_PAGES), store: createMemoryKvStore() },
    );
    expect("error" in res).toBe(true);
  });

  it("rejects an unknown target", async () => {
    const res = (await followCreatorTool(
      { agent_username: "agent-one", target_username: "ghost-target" },
      { fetchFn: registryFetch(FOLLOW_PAGES), store: createMemoryKvStore() },
    )) as { error: string };
    expect("error" in res).toBe(true);
    expect(res.error).toMatch(/no page is registered/);
  });

  it("rejects self-follow", async () => {
    const res = (await followCreatorTool(
      { agent_username: "agent-one", target_username: "agent-one" },
      { fetchFn: registryFetch(FOLLOW_PAGES), store: createMemoryKvStore() },
    )) as { error: string };
    expect("error" in res).toBe(true);
    expect(res.error).toMatch(/own page/);
  });

  it("enforces the daily quota", async () => {
    vi.stubEnv("FOLLOWS_DAILY_QUOTA", "0");
    const res = await followCreatorTool(
      { agent_username: "agent-one", target_username: "creator-bob" },
      { fetchFn: registryFetch(FOLLOW_PAGES), store: createMemoryKvStore() },
    );
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/quota/);
  });
});

describe("unfollow_creator", () => {
  it("unfollows and is idempotent", async () => {
    const store = createMemoryKvStore();
    const fx = { fetchFn: registryFetch(FOLLOW_PAGES), store };
    await followCreatorTool({ agent_username: "agent-one", target_username: "creator-bob" }, fx);
    const res = (await unfollowCreatorTool(
      { agent_username: "agent-one", target_username: "creator-bob" },
      fx,
    )) as { ok: boolean; following: string[] };
    expect(res.ok).toBe(true);
    expect(res.following).not.toContain("creator-bob");
    const again = (await unfollowCreatorTool(
      { agent_username: "agent-one", target_username: "creator-bob" },
      fx,
    )) as { ok: boolean };
    expect(again.ok).toBe(true);
  });

  it("rejects a bad agent username", async () => {
    const res = await unfollowCreatorTool(
      { agent_username: "BAD NAME", target_username: "creator-bob" },
      { fetchFn: registryFetch(FOLLOW_PAGES), store: createMemoryKvStore() },
    );
    expect("error" in res).toBe(true);
  });
});

/* ------------------------- post_hire_review ------------------------- */

const PROOF_TX = "0.0.7@1700000000.000000000";
const TX_HASH = "0x" + "ab".repeat(32);
const PURCHASE_TOPIC0 = ethers.id("PurchaseCompleted(address,address,string,uint256,uint256)");
const addrTopic = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();

function reviewFetch(opts: { tipsCall?: boolean; buyer?: string; seller?: string } = {}) {
  const { tipsCall = true, buyer = OWNER_A, seller = OWNER_B } = opts;
  const pages = {
    "reviewer-agent": { owner: OWNER_A },
    "target-agent": { owner: OWNER_B },
  };
  return mockFetch([
    [
      /contracts\/call$/,
      (url, init) => {
        const body = String((init as { body?: unknown } | undefined)?.body ?? "");
        for (const [name, p] of Object.entries(pages)) {
          if (body.includes(Buffer.from(name, "utf-8").toString("hex"))) {
            return ok({ result: resolvePageResult(p.owner) });
          }
        }
        return ok({ result: "0x" });
      },
    ],
    [/accounts\/0x/, () => ok({ account: "0.0.99999" })],
    [
      /transactions\/0\.0\.7-1700000000-000000000$/,
      () =>
        ok({
          transactions: [
            {
              result: "SUCCESS",
              name: "CONTRACTCALL",
              entity_id: tipsCall ? "0.0.10854060" : "0.0.999",
              consensus_timestamp: "1700000001.000000000",
              transaction_hash: TX_HASH,
            },
          ],
        }),
    ],
    [
      new RegExp(`contracts/results/${TX_HASH}$`),
      () =>
        ok({
          logs: [
            {
              topics: [PURCHASE_TOPIC0, addrTopic(buyer), addrTopic(seller)],
              data: "0x",
            },
          ],
        }),
    ],
  ]);
}

describe("post_hire_review", () => {
  it("posts a review backed by a real purchase tx", async () => {
    const res = (await postHireReviewTool(
      {
        agent_username: "reviewer-agent",
        target_username: "target-agent",
        rating: 5,
        text: "Fast delivery, honest pricing.",
        proof_tx_id: PROOF_TX,
      },
      reviewFetch(),
    )) as { review: { kind: string; reviewer: string; rating: number }; summary: unknown };
    expect(res.review.kind).toBe("purchase");
    expect(res.review.reviewer).toBe(OWNER_A);
    expect(res.review.rating).toBe(5);
  });

  it("rejects a proof tx that is not a Tips-contract call", async () => {
    const res = (await postHireReviewTool(
      {
        agent_username: "reviewer-agent",
        target_username: "target-agent",
        rating: 4,
        text: "ok",
        proof_tx_id: PROOF_TX,
      },
      reviewFetch({ tipsCall: false }),
    )) as { error: string };
    expect("error" in res).toBe(true);
    expect(res.error).toMatch(/Tips contract/);
  });

  it("rejects when the tx buyer is not the agent's wallet", async () => {
    const res = (await postHireReviewTool(
      {
        agent_username: "reviewer-agent",
        target_username: "target-agent",
        rating: 4,
        text: "ok",
        proof_tx_id: PROOF_TX,
      },
      reviewFetch({ buyer: OWNER_C }),
    )) as { error: string };
    expect("error" in res).toBe(true);
    expect(res.error).toMatch(/buyer does not match/);
  });

  it("rejects self-reviews", async () => {
    const res = await postHireReviewTool(
      {
        agent_username: "reviewer-agent",
        target_username: "reviewer-agent",
        rating: 5,
        text: "me me me",
        proof_tx_id: PROOF_TX,
      },
      reviewFetch(),
    );
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/own page/);
  });

  it("rejects a duplicate proof tx (one review per transaction)", async () => {
    const args = {
      agent_username: "reviewer-agent",
      target_username: "target-agent",
      rating: 5,
      text: "great",
      proof_tx_id: PROOF_TX,
    };
    const first = await postHireReviewTool(args, reviewFetch());
    expect("review" in first).toBe(true);
    const second = (await postHireReviewTool(args, reviewFetch())) as { error: string };
    expect("error" in second).toBe(true);
    expect(second.error).toMatch(/already backs a review/);
  });

  it("rejects a bad rating", async () => {
    const res = await postHireReviewTool(
      {
        agent_username: "reviewer-agent",
        target_username: "target-agent",
        rating: 6,
        text: "ok",
        proof_tx_id: PROOF_TX,
      },
      reviewFetch(),
    );
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/rating/);
  });
});

/* ------------------------- create_fundraiser ------------------------- */

function fundraiserDeps(store: ReturnType<typeof createMemoryKvStore>): GoalDeps {
  return {
    store,
    verifySession: async () => ({ ok: true as const, address: OWNER_A }),
    resolveOwner: async () => OWNER_A,
    readAllTimeHbar: async () => null,
  };
}

describe("create_fundraiser", () => {
  it("creates a fundraiser on the agent's own page", async () => {
    const res = (await createFundraiserTool(
      { agent_username: "fund-agent", target_hbar: 100, title: "Build the badge drop" },
      {
        fetchFn: registryFetch({ "fund-agent": { owner: OWNER_A } }),
        deps: fundraiserDeps(createMemoryKvStore()),
      },
    )) as { ok: boolean; fundraiser: { targetHbar: number; title: string; owner: string }; note: string };
    expect(res.ok).toBe(true);
    expect(res.fundraiser.targetHbar).toBe(100);
    expect(res.fundraiser.title).toBe("Build the badge drop");
    expect(res.fundraiser.owner).toBe(OWNER_A);
    expect(res.note).toMatch(/98%/);
  });

  it("rejects an unregistered agent identity", async () => {
    const res = await createFundraiserTool(
      { agent_username: "ghost-agent", target_hbar: 100 },
      {
        fetchFn: registryFetch({ "fund-agent": { owner: OWNER_A } }),
        deps: fundraiserDeps(createMemoryKvStore()),
      },
    );
    expect("error" in res).toBe(true);
  });

  it("rejects an invalid target", async () => {
    const res = (await createFundraiserTool(
      { agent_username: "fund-agent", target_hbar: 0 },
      {
        fetchFn: registryFetch({ "fund-agent": { owner: OWNER_A } }),
        deps: fundraiserDeps(createMemoryKvStore()),
      },
    )) as { error: string };
    expect("error" in res).toBe(true);
    expect(res.error).toMatch(/target/);
  });

  it("enforces the daily quota", async () => {
    vi.stubEnv("MCP_FUNDRAISER_DAILY_QUOTA", "0");
    const res = await createFundraiserTool(
      { agent_username: "fund-agent", target_hbar: 100 },
      {
        fetchFn: registryFetch({ "fund-agent": { owner: OWNER_A } }),
        deps: fundraiserDeps(createMemoryKvStore()),
      },
    );
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/quota/);
  });
});

/* ------------------------- manage_music ------------------------- */

function musicPageFixture(pageJson: unknown, ipfsHash = PAGE_CID) {
  const bytes = new TextEncoder().encode(JSON.stringify(pageJson));
  const pages = { "music-agent": { owner: OWNER_A, ipfsHash } };
  return (async (input: any, init?: any) => {
    const url = String(input);
    if (/contracts\/call$/.test(url)) {
      const body = String((init as { body?: unknown } | undefined)?.body ?? "");
      for (const [name, p] of Object.entries(pages)) {
        if (body.includes(Buffer.from(name, "utf-8").toString("hex"))) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ result: resolvePageResult(p.owner, p.ipfsHash) }),
          } as Response;
        }
      }
      return { ok: true, status: 200, json: async () => ({ result: "0x" }) } as Response;
    }
    if (/accounts\/0x/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ account: "0.0.99999" }) } as Response;
    }
    if (url.includes("gateway.pinata.cloud/ipfs/")) {
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: async () => {
                if (sent) return { done: true, value: undefined };
                sent = true;
                return { done: false, value: bytes };
              },
              cancel: async () => {},
            };
          },
        },
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const SPOTIFY_URL = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQm";
const YOUTUBE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function basePage(tracks: unknown[]) {
  return {
    displayName: "music-agent",
    blocks: [{ type: "music", title: "My music", tracks }],
  };
}

describe("manage_music", () => {
  it("adds a track to the existing music block", async () => {
    const raw = await manageMusicTool(
      { agent_username: "music-agent", action: "add", track_url: SPOTIFY_URL, title: "My jam" },
      musicPageFixture(basePage([])),
    );
    if ("error" in raw) throw new Error(`unexpected error: ${raw.error}`);
    const res = raw as unknown as {
      track_count: number;
      track: { source: string; id: string; title?: string };
      updated_page_json: { blocks: { type: string; tracks: unknown[] }[] };
      page_sha256: string;
      next: string;
    };
    expect(res.track_count).toBe(1);
    expect(res.track.source).toBe("spotify");
    expect(res.track.id).toBe("4uLU6hMCjMI75M1A2tKUQm");
    expect(res.track.title).toBe("My jam");
    expect(res.updated_page_json.blocks[0].tracks).toHaveLength(1);
    const expected = createHash("sha256")
      .update(JSON.stringify(res.updated_page_json), "utf-8")
      .digest("hex");
    expect(res.page_sha256).toBe(expected);
    expect(res.next).toMatch(/updatePage/);
    expect(res.next).toMatch(/0\.0\.10854060/);
  });

  it("creates the music block when the page has none", async () => {
    const raw = await manageMusicTool(
      { agent_username: "music-agent", action: "add", track_url: YOUTUBE_URL },
      musicPageFixture({ displayName: "music-agent", blocks: [{ type: "text", text: "hi" }] }),
    );
    if ("error" in raw) throw new Error(`unexpected error: ${raw.error}`);
    const res = raw as unknown as {
      track_count: number;
      updated_page_json: { blocks: { type: string }[] };
    };
    expect(res.track_count).toBe(1);
    expect(res.updated_page_json.blocks.some((b) => b.type === "music")).toBe(true);
  });

  it("adds an ipfs upload by cid", async () => {
    const cid = "baf" + "a".repeat(56);
    const res = (await manageMusicTool(
      { agent_username: "music-agent", action: "add", ipfs_cid: cid, artist: "me" },
      musicPageFixture(basePage([])),
    )) as { track: { source: string; id: string; artist?: string } };
    expect(res.track.source).toBe("ipfs");
    expect(res.track.id).toBe(cid);
    expect(res.track.artist).toBe("me");
  });

  it("rejects an unparseable track url", async () => {
    const res = await manageMusicTool(
      { agent_username: "music-agent", action: "add", track_url: "https://example.com/nope" },
      musicPageFixture(basePage([])),
    );
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/Spotify/);
  });

  it("rejects duplicates", async () => {
    const page = basePage([
      { source: "spotify", kind: "track", id: "4uLU6hMCjMI75M1A2tKUQm", url: SPOTIFY_URL },
    ]);
    const res = await manageMusicTool(
      { agent_username: "music-agent", action: "add", track_url: SPOTIFY_URL },
      musicPageFixture(page),
    );
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/already/);
  });

  it("removes a track by index", async () => {
    const page = basePage([
      { source: "spotify", kind: "track", id: "4uLU6hMCjMI75M1A2tKUQm", url: SPOTIFY_URL },
      { source: "youtube", kind: "video", id: "dQw4w9WgXcQ", url: YOUTUBE_URL },
    ]);
    const res = (await manageMusicTool(
      { agent_username: "music-agent", action: "remove", track_index: 0 },
      musicPageFixture(page),
    )) as {
      action: string;
      track: { id: string };
      track_count: number;
      tracks: { id: string }[];
    };
    expect(res.action).toBe("remove");
    expect(res.track.id).toBe("4uLU6hMCjMI75M1A2tKUQm");
    expect(res.track_count).toBe(1);
    expect(res.tracks[0].id).toBe("dQw4w9WgXcQ");
  });

  it("removes a track by url match", async () => {
    const page = basePage([
      { source: "youtube", kind: "video", id: "dQw4w9WgXcQ", url: YOUTUBE_URL },
    ]);
    const res = (await manageMusicTool(
      { agent_username: "music-agent", action: "remove", track_url: YOUTUBE_URL },
      musicPageFixture(page),
    )) as { track_count: number };
    expect(res.track_count).toBe(0);
  });

  it("errors on an out-of-range index", async () => {
    const res = await manageMusicTool(
      { agent_username: "music-agent", action: "remove", track_index: 9 },
      musicPageFixture(basePage([])),
    );
    expect("error" in res).toBe(true);
  });

  it("rejects an unknown agent", async () => {
    const res = await manageMusicTool(
      { agent_username: "ghost-agent", action: "add", track_url: SPOTIFY_URL },
      musicPageFixture(basePage([])),
    );
    expect("error" in res).toBe(true);
  });

  it("errors when the page has no pinned content", async () => {
    const res = await manageMusicTool(
      { agent_username: "music-agent", action: "add", track_url: SPOTIFY_URL },
      musicPageFixture(basePage([]), ""),
    );
    expect("error" in res).toBe(true);
    expect((res as { error: string }).error).toMatch(/no pinned page content/);
  });
});
