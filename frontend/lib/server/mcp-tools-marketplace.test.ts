/**
 * MCP marketplace tools — unit tests.
 *
 * Mirror node, HCS, and Pinata are all faked; the real network is never
 * touched. Fixtures follow the mockFetch pattern from mcp-tools.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import {
  createListingTool,
  uploadDigitalGoodTool,
  type MarketplaceToolDeps,
  type PreparedListing,
} from "./mcp-tools-marketplace";
import type { TownhallDeps } from "./townhall/handlers";
import { requestContextStorage } from "./mcp-tools";
import { resetKvStoreSingleton } from "./store";
import { createMemoryQuotaStore } from "./quota";

const MARKET_TOPIC = "0.0.987654";
const FORUM_TOPIC = "0.0.987653";
const AGENT_OWNER_EVM = "0xabc1230000000000000000000000000000000001";
const AGENT_ACCOUNT = "0.0.777";

const RESOLVE_IFACE = new ethers.Interface([
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
]);

function resolvePageResult(ownerType: number, owner: string = AGENT_OWNER_EVM): string {
  return RESOLVE_IFACE.encodeFunctionResult("resolvePage", [
    owner,
    "QmTestHash",
    BigInt(ownerType),
    "0x0000000000000000000000000000000000000000",
    "test agent",
  ]);
}

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

/** Mirror mock: registered agent page (ownerType 1) by default. */
function mirrorFetch(ownerType: number | "unregistered" = 1) {
  return (async (url: string) => {
    if (url.includes("/contracts/call")) {
      return ownerType === "unregistered" ? ok({ result: "0x" }) : ok({ result: resolvePageResult(ownerType) });
    }
    if (url.includes("/accounts/")) {
      return ok({ account: AGENT_ACCOUNT });
    }
    throw new Error("unexpected fetch " + url);
  }) as unknown as typeof fetch;
}

function fakeDeps(over: {
  verifyTx?: (txId: string, topic: string, payer: string) => Promise<{ message: string } | null>;
  queryAll?: (topic: string) => Promise<unknown[]>;
} = {}): TownhallDeps {
  return {
    hcs: {
      verifyTx: over.verifyTx ?? (async () => null),
      query: async () => [],
      queryAll: (over.queryAll ?? (async () => [])) as TownhallDeps["hcs"]["queryAll"],
    },
    mirror: {
      resolveAccountId: async () => AGENT_ACCOUNT,
    },
    registry: {},
    auth: {},
    sales: {},
  } as unknown as TownhallDeps;
}

const CTX = { origin: "https://voicescape.vercel.app", clientIp: "9.9.9.9", requestId: null, authToken: null };

function withCtx<T>(fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run(CTX, fn);
}

const GOOD_LISTING = {
  agent_username: "badgebot",
  title: "Oct 31 Badge Drop",
  description: "A limited badge for early supporters.",
  price_usd_cents: 100,
  goods_type: "digital" as const,
  ipfs_hash: "bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4q",
};

function injected(over: Partial<MarketplaceToolDeps> = {}): MarketplaceToolDeps {
  return {
    fetchFn: mirrorFetch(1),
    townhallDeps: fakeDeps(),
    quotaStore: createMemoryQuotaStore(),
    publishFn: async () => ({ cid: "bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4q" }),
    ...over,
  };
}

describe("createListingTool — prepare step", () => {
  let prevMarket: string | undefined;
  let prevForum: string | undefined;
  let prevPrepareQuota: string | undefined;

  beforeEach(() => {
    resetKvStoreSingleton();
    prevMarket = process.env.TOWNHALL_TOPIC_MARKET;
    prevForum = process.env.TOWNHALL_TOPIC_FORUM;
    prevPrepareQuota = process.env.MCP_LISTING_PREPARE_DAILY_QUOTA;
    process.env.TOWNHALL_TOPIC_MARKET = MARKET_TOPIC;
    process.env.TOWNHALL_TOPIC_FORUM = FORUM_TOPIC;
    delete process.env.MCP_LISTING_PREPARE_DAILY_QUOTA;
    vi.restoreAllMocks();
  });

  it("rejects an invalid username", async () => {
    const res = await withCtx(() => createListingTool({ ...GOOD_LISTING, agent_username: "ab" }, injected()));
    expect("error" in res).toBe(true);
  });

  it("rejects an unregistered page", async () => {
    const res = await withCtx(() =>
      createListingTool(GOOD_LISTING, injected({ fetchFn: mirrorFetch("unregistered") })),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/not registered/i);
  });

  it("rejects a human-owned page (agent tools are for agent pages)", async () => {
    const res = await withCtx(() =>
      createListingTool(GOOD_LISTING, injected({ fetchFn: mirrorFetch(0) })),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/human page/i);
  });

  it("rejects a restricted (banned) wallet", async () => {
    const deps = fakeDeps({
      queryAll: async () => [
        {
          contents: {
            kind: "ban",
            wallet: AGENT_OWNER_EVM,
            reason: "test ban",
            ts: "2026-10-07T00:00:00Z",
            expiresAt: null,
          },
        },
      ],
    });
    const res = await withCtx(() => createListingTool(GOOD_LISTING, injected({ townhallDeps: deps })));
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/banned/i);
  });

  it("rejects a negative price", async () => {
    const res = await withCtx(() =>
      createListingTool({ ...GOOD_LISTING, price_usd_cents: -5 }, injected()),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/price_usd_cents/i);
  });

  it("rejects a bad goods_type", async () => {
    const res = await withCtx(() =>
      createListingTool({ ...GOOD_LISTING, goods_type: "service" as never }, injected()),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/goods_type/i);
  });

  it("rejects a malformed ipfs_hash", async () => {
    const res = await withCtx(() =>
      createListingTool({ ...GOOD_LISTING, ipfs_hash: "not-a-cid" }, injected()),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/ipfs_hash/i);
  });

  it("blocks content the safety filter rejects (pre-HCS gate)", async () => {
    const res = await withCtx(() =>
      createListingTool({ ...GOOD_LISTING, title: "Badge — contact me at foo@bar.com" }, injected()),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/blocked/i);
  });

  it("errors when the market topic is not configured", async () => {
    delete process.env.TOWNHALL_TOPIC_MARKET;
    const res = await withCtx(() => createListingTool(GOOD_LISTING, injected()));
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/not configured/i);
  });

  it("returns the exact unsigned HCS message for the agent to submit", async () => {
    const res = await withCtx(() => createListingTool(GOOD_LISTING, injected()));
    expect("error" in res).toBe(false);
    const p = res as PreparedListing;
    expect(p.prepared).toBe(true);
    expect(p.topic).toBe(MARKET_TOPIC);
    expect(p.payout_address).toBe(AGENT_OWNER_EVM);
    expect(p.message).toMatchObject({
      v: 1,
      kind: "listing",
      author: "badgebot",
      seller: AGENT_OWNER_EVM,
      sellerUsername: "badgebot",
      title: "Oct 31 Badge Drop",
      description: "A limited badge for early supporters.",
      priceUsdCents: 100,
      goodsType: "digital",
      ipfsHash: GOOD_LISTING.ipfs_hash,
      status: "active",
    });
    expect(typeof p.listing_id).toBe("string");
    expect(p.message.id).toBe(p.listing_id);
    expect(p.instructions).toMatch(/hcs_tx_id/);
  });

  it("enforces the per-wallet daily prepare quota", async () => {
    process.env.MCP_LISTING_PREPARE_DAILY_QUOTA = "1";
    const inj = injected();
    const first = await withCtx(() => createListingTool(GOOD_LISTING, inj));
    expect("error" in first).toBe(false);
    const second = await withCtx(() => createListingTool(GOOD_LISTING, inj));
    expect("error" in second).toBe(true);
    if ("error" in second) expect(second.error).toMatch(/limit reached/i);
  });
});

describe("createListingTool — confirm step", () => {
  beforeEach(() => {
    resetKvStoreSingleton();
    process.env.TOWNHALL_TOPIC_MARKET = MARKET_TOPIC;
    process.env.TOWNHALL_TOPIC_FORUM = FORUM_TOPIC;
  });

  async function prepareAndConfirm(verifyMessage: (p: PreparedListing) => string | null) {
    const inj = injected();
    const prepared = (await withCtx(() => createListingTool(GOOD_LISTING, inj))) as PreparedListing;
    expect(prepared.prepared).toBe(true);
    const msg = verifyMessage(prepared);
    const deps = fakeDeps({ verifyTx: async () => (msg === null ? null : { message: msg }) });
    return withCtx(() =>
      createListingTool(
        { ...GOOD_LISTING, listing_id: prepared.listing_id, hcs_tx_id: "0.0.777@1790000000.000000001" },
        injected({ townhallDeps: deps }),
      ),
    );
  }

  it("requires listing_id in step 2", async () => {
    const res = await withCtx(() =>
      createListingTool({ ...GOOD_LISTING, hcs_tx_id: "0.0.777@1790000000.000000001" }, injected()),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/listing_id is required/i);
  });

  it("accepts a caller-chosen listing_id in step 1", async () => {
    const res = await withCtx(() =>
      createListingTool({ ...GOOD_LISTING, listing_id: "my-badge-drop-2026" }, injected()),
    );
    expect("error" in res).toBe(false);
    if (!("error" in res) && "prepared" in res) {
      expect(res.listing_id).toBe("my-badge-drop-2026");
      expect((res as PreparedListing).message.id).toBe("my-badge-drop-2026");
    }
  });

  it("confirms when the on-chain message matches exactly", async () => {
    const res = await prepareAndConfirm((p) => JSON.stringify(p.message));
    expect("error" in res).toBe(false);
    if (!("error" in res) && "confirmed" in res) {
      expect(res.confirmed).toBe(true);
      expect(res.listing_url).toMatch(/\/marketplace\//);
      expect(res.hcs_tx_id).toBe("0.0.777@1790000000.000000001");
    }
  });

  it("rejects when the on-chain content differs", async () => {
    const res = await prepareAndConfirm((p) =>
      JSON.stringify({ ...p.message, priceUsdCents: 99999 }),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/mismatch/i);
  });

  it("rejects when the tx does not verify", async () => {
    const res = await prepareAndConfirm(() => null);
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/verification failed/i);
  });

  it("replay-protects the hcs_tx_id (one tx, one listing)", async () => {
    const inj = injected();
    const prepared = (await withCtx(() => createListingTool(GOOD_LISTING, inj))) as PreparedListing;
    const deps = fakeDeps({ verifyTx: async () => ({ message: JSON.stringify(prepared.message) }) });
    const confirmArgs = {
      ...GOOD_LISTING,
      listing_id: prepared.listing_id,
      hcs_tx_id: "0.0.777@1790000000.000000002",
    };
    const first = await withCtx(() => createListingTool(confirmArgs, injected({ townhallDeps: deps })));
    expect("error" in first).toBe(false);
    const second = await withCtx(() => createListingTool(confirmArgs, injected({ townhallDeps: deps })));
    expect("error" in second).toBe(true);
    if ("error" in second) expect(second.error).toMatch(/already used/i);
  });
});

describe("uploadDigitalGoodTool", () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];
  const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a];
  const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

  beforeEach(() => {
    resetKvStoreSingleton();
    process.env.TOWNHALL_TOPIC_FORUM = FORUM_TOPIC;
    delete process.env.DIGITAL_GOOD_DAILY_QUOTA;
    vi.restoreAllMocks();
  });

  it("rejects an unregistered page", async () => {
    const res = await withCtx(() =>
      uploadDigitalGoodTool(
        { agent_username: "ghostbot", file_base64: b64(PNG), filename: "badge.png" },
        injected({ fetchFn: mirrorFetch("unregistered") }),
      ),
    );
    expect("error" in res).toBe(true);
  });

  it("rejects invalid base64", async () => {
    const res = await withCtx(() =>
      uploadDigitalGoodTool(
        { agent_username: "badgebot", file_base64: "!!!not-base64!!!", filename: "badge.png" },
        injected(),
      ),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/base64/i);
  });

  it("rejects an empty file", async () => {
    const res = await withCtx(() =>
      uploadDigitalGoodTool(
        { agent_username: "badgebot", file_base64: b64([]), filename: "badge.png" },
        injected(),
      ),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/empty/i);
  });

  it("rejects an oversized file", async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 0x89);
    big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47; // PNG magic so it fails on size, not type
    const res = await withCtx(() =>
      uploadDigitalGoodTool(
        { agent_username: "badgebot", file_base64: big.toString("base64"), filename: "big.png" },
        injected(),
      ),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/too large/i);
  });

  it("rejects an unsupported file type by magic bytes", async () => {
    const text = Array.from(Buffer.from("hello world, not an image or pdf or zip"));
    const res = await withCtx(() =>
      uploadDigitalGoodTool(
        { agent_username: "badgebot", file_base64: b64(text), filename: "evil.exe" },
        injected(),
      ),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/unsupported file type/i);
  });

  it("pins a PNG and returns its CID", async () => {
    const publishFn = vi.fn(async () => ({ cid: "bafkreipngtestcid00000000000000000000000000000000000000000001" }));
    const res = await withCtx(() =>
      uploadDigitalGoodTool(
        { agent_username: "badgebot", file_base64: b64(PNG), filename: "my badge.png" },
        injected({ publishFn }),
      ),
    );
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.kind).toBe("image");
      expect(res.cid).toMatch(/^baf/);
    }
    expect(publishFn).toHaveBeenCalledOnce();
    const [, storedName, mime] = publishFn.mock.calls[0] as unknown as [Uint8Array, string, string];
    // Privacy: user-controlled filename is neutralized, safe extension kept.
    expect(storedName).toMatch(/^digital-good-\d+\.png$/);
    expect(mime).toBe("image/png");
  });

  it("pins a PDF and reports its kind", async () => {
    const res = await withCtx(() =>
      uploadDigitalGoodTool(
        { agent_username: "badgebot", file_base64: b64(PDF), filename: "whitepaper.pdf" },
        injected(),
      ),
    );
    expect("error" in res).toBe(false);
    if (!("error" in res)) expect(res.kind).toBe("pdf");
  });

  it("enforces the same daily upload quota as the web route", async () => {
    process.env.DIGITAL_GOOD_DAILY_QUOTA = "1";
    const inj = injected();
    const first = await withCtx(() =>
      uploadDigitalGoodTool({ agent_username: "badgebot", file_base64: b64(PNG), filename: "a.png" }, inj),
    );
    expect("error" in first).toBe(false);
    const second = await withCtx(() =>
      uploadDigitalGoodTool({ agent_username: "badgebot", file_base64: b64(PNG), filename: "b.png" }, inj),
    );
    expect("error" in second).toBe(true);
    if ("error" in second) expect(second.error).toMatch(/daily digital-good upload limit reached/i);
  });

  it("rejects a restricted (banned) wallet", async () => {
    const deps = fakeDeps({
      queryAll: async () => [
        {
          contents: {
            kind: "ban",
            wallet: AGENT_OWNER_EVM,
            reason: "test ban",
            ts: "2026-10-07T00:00:00Z",
            expiresAt: null,
          },
        },
      ],
    });
    const res = await withCtx(() =>
      uploadDigitalGoodTool(
        { agent_username: "badgebot", file_base64: b64(PNG), filename: "badge.png" },
        injected({ townhallDeps: deps }),
      ),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/banned/i);
  });

  it("surfaces pinning outages cleanly", async () => {
    const res = await withCtx(() =>
      uploadDigitalGoodTool(
        { agent_username: "badgebot", file_base64: b64(PNG), filename: "badge.png" },
        injected({
          publishFn: async () => {
            throw new Error("PINATA_UNAVAILABLE");
          },
        }),
      ),
    );
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toMatch(/temporarily unavailable/i);
  });
});
