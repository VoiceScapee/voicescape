/**
 * Agent NFT Drops — unit tests.
 *
 * Mirror node and Pinata are faked; the real network is never touched and
 * no HBAR is ever spent. Unsigned transaction bytes are decoded with the
 * real @hiero-ledger/sdk and asserted structurally (right tx type, right
 * fields, frozen, no signatures, no key material).
 */
import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import {
  Transaction,
  TokenCreateTransaction,
  TokenMintTransaction,
  TokenAssociateTransaction,
} from "@hiero-ledger/sdk";
import {
  prepareNftCollection,
  prepareNftMint,
  getNftCollection,
  prepareNftAssociation,
  buildHip412Metadata,
  validateHip412Metadata,
  decodeNftMetadata,
  resolveNftMedia,
  type NftToolDeps,
} from "./mcp-tools-nft";
import type { TownhallDeps } from "./townhall/handlers";
import { requestContextStorage } from "./mcp-tools";
import { createMemoryQuotaStore } from "./quota";

const AGENT_OWNER_EVM = "0xabc1230000000000000000000000000000000001";
const AGENT_ACCOUNT = "0.0.777";
const TOKEN_ID = "0.0.999888";
const ED25519_PUB = "a".repeat(64);
const ART_CID = "Qm" + "b".repeat(44);
const META_CID = "Qm" + "c".repeat(44);

const RESOLVE_IFACE = new ethers.Interface([
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
]);

function resolvePageResult(ownerType: number): string {
  return RESOLVE_IFACE.encodeFunctionResult("resolvePage", [
    AGENT_OWNER_EVM,
    "QmTestHash",
    BigInt(ownerType),
    "0x0000000000000000000000000000000000000000",
    "test agent",
  ]);
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function notFound() {
  return { ok: false, status: 404, json: async () => ({}) };
}

function tokenJson(over: Record<string, unknown> = {}) {
  return {
    token_id: TOKEN_ID,
    name: "Test Drops",
    symbol: "TDROP",
    type: "NON_FUNGIBLE_UNIQUE",
    treasury_account_id: AGENT_ACCOUNT,
    max_supply: "100",
    total_supply: "2",
    ...over,
  };
}

/** Mirror mock: registered agent page + an NFT collection + 2 serials. */
function mirrorFetch() {
  return (async (url: string) => {
    if (url.includes("/contracts/call")) return ok({ result: resolvePageResult(1) });
    if (url.includes("/accounts/")) {
      // token-relationship check for association
      if (url.includes("/tokens?")) return ok({ tokens: [] });
      return ok({ account: AGENT_ACCOUNT });
    }
    if (url.includes(`/tokens/${TOKEN_ID}/nfts`)) {
      return ok({
        nfts: [
          {
            serial_number: 2,
            metadata: Buffer.from(`ipfs://${META_CID}`, "utf8").toString("base64"),
          },
          {
            serial_number: 1,
            metadata: Buffer.from(`ipfs://${META_CID}`, "utf8").toString("base64"),
          },
        ],
      });
    }
    if (url.includes(`/tokens/${TOKEN_ID}`)) return ok(tokenJson());
    if (url.includes("ipfs.io/ipfs/" + META_CID)) {
      return ok(
        buildHip412Metadata({
          name: "Drip #2",
          description: "Second drop",
          imageCid: ART_CID,
          mime: "image/png",
          creator: "testagent",
          collectionName: "Test Drops",
          tokenId: TOKEN_ID,
        }),
      );
    }
    throw new Error("unexpected fetch " + url);
  }) as unknown as typeof fetch;
}

function fakeDeps(): TownhallDeps {
  return {
    hcs: { verifyTx: async () => null, query: async () => [], queryAll: async () => [] },
    mirror: { resolveAccountId: async () => AGENT_ACCOUNT },
    registry: {},
    auth: {},
    sales: {},
  } as unknown as TownhallDeps;
}

const CTX = {
  origin: "https://voicescape.vercel.app",
  clientIp: "9.9.9.9",
  requestId: null,
  authToken: null,
};
function withCtx<T>(fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run(CTX, fn);
}

/** 1x1 PNG bytes for the art pin path. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface TestDeps extends NftToolDeps {
  pinned: Array<{ filename: string; mime: string; bytes: Uint8Array }>;
}

function deps(over: Partial<NftToolDeps> = {}): TestDeps {
  const pinned: TestDeps["pinned"] = [];
  return {
    fetchFn: mirrorFetch(),
    townhallDeps: fakeDeps(),
    quotaStore: createMemoryQuotaStore(),
    publishFn: async (data, filename, mime) => {
      pinned.push({ filename, mime, bytes: data });
      // First pin = art, second pin = metadata JSON (deterministic CIDs).
      return { cid: pinned.length === 1 ? ART_CID : META_CID };
    },
    ...over,
    pinned,
  };
}

function decodeUnsigned(b64: string): Transaction {
  return Transaction.fromBytes(Buffer.from(b64, "base64"));
}

describe("prepare_nft_collection", () => {
  it("returns frozen unsigned TokenCreate bytes with the page account as treasury", async () => {
    const res = await withCtx(() =>
      prepareNftCollection(
        {
          agent_username: "testagent",
          name: "Test Drops",
          symbol: "tdrop",
          max_supply: 100,
          supply_public_key: ED25519_PUB,
        },
        deps(),
      ),
    );
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.prepared).toBe(true);
    expect(res.treasury).toBe(AGENT_ACCOUNT);
    expect(res.symbol).toBe("TDROP");

    const tx = decodeUnsigned(res.unsignedTxBytes);
    expect(tx).toBeInstanceOf(TokenCreateTransaction);
    expect(tx.isFrozen()).toBe(true);
    const create = tx as TokenCreateTransaction;
    expect(create.tokenName).toBe("Test Drops");
    expect(create.tokenSymbol).toBe("TDROP");
    expect(create.maxSupply?.toString()).toBe("100");
    expect(create.treasuryAccountId?.toString()).toBe(AGENT_ACCOUNT);

    // No signatures, no key material: the bytes must not contain any
    // private key, and the result must not echo one either.
    const dumped = JSON.stringify(res);
    expect(dumped).not.toMatch(/private/i);
    expect(res.transactionId).toMatch(/^0\.0\.777@\d+\.\d+$/);
  });

  it("rejects bad input without touching the network for tx building", async () => {
    const d = deps();
    const badSymbol = await withCtx(() =>
      prepareNftCollection(
        { agent_username: "testagent", name: "Ok Name", symbol: "way-too-long-symbol", max_supply: 10, supply_public_key: ED25519_PUB },
        d,
      ),
    );
    expect("error" in badSymbol && badSymbol.error).toMatch(/symbol/);

    const badSupply = await withCtx(() =>
      prepareNftCollection(
        { agent_username: "testagent", name: "Ok Name", symbol: "OK", max_supply: 99999, supply_public_key: ED25519_PUB },
        deps(),
      ),
    );
    expect("error" in badSupply && badSupply.error).toMatch(/max_supply/);

    const badKey = await withCtx(() =>
      prepareNftCollection(
        { agent_username: "testagent", name: "Ok Name", symbol: "OK", max_supply: 10, supply_public_key: "not-a-key" },
        deps(),
      ),
    );
    expect("error" in badKey && badKey.error).toMatch(/public key/);

    const badName = await withCtx(() =>
      prepareNftCollection(
        { agent_username: "testagent", name: "ab", symbol: "OK", max_supply: 10, supply_public_key: ED25519_PUB },
        deps(),
      ),
    );
    expect("error" in badName && badName.error).toMatch(/name/);
  });

  it("rejects unregistered pages", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return ok({ result: "0x" });
      throw new Error("unexpected " + url);
    }) as unknown as typeof fetch;
    const res = await withCtx(() =>
      prepareNftCollection(
        { agent_username: "ghost", name: "Ghost Drops", symbol: "GHOST", max_supply: 10, supply_public_key: ED25519_PUB },
        deps({ fetchFn }),
      ),
    );
    expect("error" in res && res.error).toMatch(/not registered/);
  });
});

describe("prepare_nft_mint", () => {
  it("pins art + HIP-412 JSON and returns unsigned TokenMint bytes pointing at the JSON", async () => {
    const d = deps() as NftToolDeps & { pinned: Array<{ filename: string; mime: string; bytes: Uint8Array }> };
    const publishFn = d.publishFn!;
    const res = await withCtx(() =>
      prepareNftMint(
        {
          agent_username: "testagent",
          token_id: TOKEN_ID,
          name: "Drip #1",
          description: "First drop",
          image_base64: PNG_BYTES.toString("base64"),
          filename: "drip.png",
        },
        { ...d, publishFn },
      ),
    );
    expect("error" in res).toBe(false);
    if ("error" in res) return;

    // Two pins: artwork, then the wallet-readable metadata JSON.
    expect(d.pinned.length).toBe(2);
    expect(d.pinned[0].mime).toBe("image/png");
    expect(d.pinned[1].mime).toBe("application/json");

    // ACCEPTANCE: the pinned metadata parses against the wallet schema…
    const metaJson = JSON.parse(Buffer.from(d.pinned[1].bytes).toString("utf8"));
    expect(validateHip412Metadata(metaJson)).toEqual([]);
    expect(metaJson.name).toBe("Drip #1");
    // …and its image CID resolves to the pinned artwork.
    const imgCid = (metaJson.image as string).replace("ipfs://", "");
    expect(imgCid).toBe(ART_CID);
    expect(d.pinned[0].filename).toMatch(/^nft-art-/);

    // The on-chain metadata field is the JSON's URI (≤100 bytes).
    expect(res.metadata).toBe(`ipfs://${META_CID}`);
    expect(Buffer.byteLength(res.metadata, "utf8")).toBeLessThanOrEqual(100);
    expect(res.metadataCid).toBe(META_CID);
    expect(res.artCid).toBe(ART_CID);
    expect(res.metadataJson.name).toBe("Drip #1");

    const tx = decodeUnsigned(res.unsignedTxBytes);
    expect(tx).toBeInstanceOf(TokenMintTransaction);
    expect(tx.isFrozen()).toBe(true);
    const mint = tx as TokenMintTransaction;
    expect(mint.tokenId?.toString()).toBe(TOKEN_ID);
    const metaBytes = mint.metadata ?? [];
    expect(metaBytes.length).toBe(1);
    expect(Buffer.from(metaBytes[0]).toString("utf8")).toBe(`ipfs://${META_CID}`);
    const dumped = JSON.stringify(res);
    expect(dumped).not.toMatch(/private/i);
  });

  it("accepts a caller-pinned image CID with no art pin", async () => {
    const d = deps() as NftToolDeps & { pinned: Array<{ filename: string; mime: string; bytes: Uint8Array }> };
    const res = await withCtx(() =>
      prepareNftMint(
        { agent_username: "testagent", token_id: TOKEN_ID, name: "Drip #2", image_cid: ART_CID, image_mime: "image/jpeg" },
        d,
      ),
    );
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    // Only the metadata JSON was pinned — the art pin was the caller's.
    expect(d.pinned.length).toBe(1);
    expect(d.pinned[0].mime).toBe("application/json");
    const metaJson = JSON.parse(Buffer.from(d.pinned[0].bytes).toString("utf8"));
    expect(metaJson.type).toBe("image/jpeg");
    expect(metaJson.image).toBe(`ipfs://${ART_CID}`);
  });

  it("refuses to mint into someone else's collection", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return ok({ result: resolvePageResult(1) });
      if (url.includes("/accounts/")) return ok({ account: AGENT_ACCOUNT });
      if (url.includes(`/tokens/${TOKEN_ID}`) && !url.includes("/nfts"))
        return ok(tokenJson({ treasury_account_id: "0.0.12345" }));
      throw new Error("unexpected " + url);
    }) as unknown as typeof fetch;
    const res = await withCtx(() =>
      prepareNftMint(
        { agent_username: "testagent", token_id: TOKEN_ID, name: "Sneaky", image_cid: ART_CID },
        deps({ fetchFn }),
      ),
    );
    expect("error" in res && res.error).toMatch(/not yours/);
  });

  it("refuses non-NFT tokens", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/contracts/call")) return ok({ result: resolvePageResult(1) });
      if (url.includes("/accounts/")) return ok({ account: AGENT_ACCOUNT });
      if (url.includes(`/tokens/${TOKEN_ID}`) && !url.includes("/nfts"))
        return ok(tokenJson({ type: "FUNGIBLE_COMMON" }));
      throw new Error("unexpected " + url);
    }) as unknown as typeof fetch;
    const res = await withCtx(() =>
      prepareNftMint(
        { agent_username: "testagent", token_id: TOKEN_ID, name: "Sneaky", image_cid: ART_CID },
        deps({ fetchFn }),
      ),
    );
    expect("error" in res && res.error).toMatch(/not an NFT collection/);
  });

  it("rejects non-image uploads", async () => {
    const res = await withCtx(() =>
      prepareNftMint(
        {
          agent_username: "testagent",
          token_id: TOKEN_ID,
          name: "Drip",
          image_base64: Buffer.from("%PDF-1.4 fake").toString("base64"),
        },
        deps(),
      ),
    );
    expect("error" in res && res.error).toMatch(/must be an image/);
  });
});

describe("HIP-412 metadata schema", () => {
  it("accepts the builder output and rejects malformed documents", () => {
    const good = buildHip412Metadata({
      name: "Drip #1",
      description: "First",
      imageCid: ART_CID,
      mime: "image/png",
      creator: "testagent",
      collectionName: "Test Drops",
      tokenId: TOKEN_ID,
    });
    expect(validateHip412Metadata(good)).toEqual([]);

    expect(validateHip412Metadata({ ...good, image: "https://example.com/x.png" }).length).toBeGreaterThan(0);
    expect(validateHip412Metadata({ ...good, name: "" }).length).toBeGreaterThan(0);
    expect(validateHip412Metadata({ ...good, image: "ipfs://notacid!!!" }).length).toBeGreaterThan(0);
    expect(validateHip412Metadata(null).length).toBeGreaterThan(0);
  });

  it("decodeNftMetadata decodes mirror base64", () => {
    const raw = Buffer.from("ipfs://" + META_CID, "utf8").toString("base64");
    expect(decodeNftMetadata(raw)).toBe(`ipfs://${META_CID}`);
    expect(decodeNftMetadata("")).toBe("");
  });
});

describe("get_nft_collection", () => {
  it("returns token info with resolved artwork from the metadata JSON", async () => {
    const res = await withCtx(() => getNftCollection({ token_id: TOKEN_ID }, deps()));
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.name).toBe("Test Drops");
    expect(res.hashscanUrl).toBe(`https://hashscan.io/mainnet/token/${TOKEN_ID}`);
    expect(res.nfts.length).toBe(2);
    expect(res.nfts[0].serial).toBe(2);
    // Artwork resolved through the HIP-412 JSON (dual visibility: the same
    // document HashPack reads).
    expect(res.nfts[0].imageUrl).toBe(`https://ipfs.io/ipfs/${ART_CID}`);
    expect(res.nfts[0].name).toBe("Drip #2");
  });

  it("rejects malformed token ids", async () => {
    const res = await withCtx(() => getNftCollection({ token_id: "nope" }, deps()));
    expect("error" in res && res.error).toMatch(/0\.0\.123456/);
  });
});

describe("resolveNftMedia", () => {
  it("returns nulls when the gateway cannot answer", async () => {
    const badFetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const media = await resolveNftMedia(`ipfs://${META_CID}`, badFetch);
    expect(media).toEqual({ imageUrl: null, name: null });
  });
});

describe("prepare_nft_association", () => {
  it("returns unsigned TokenAssociate bytes for the buyer's account", async () => {
    const res = await withCtx(() =>
      prepareNftAssociation({ account_id: "0.0.555", token_id: TOKEN_ID }, deps()),
    );
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.prepared).toBe(true);
    expect(res.alreadyAssociated).toBeUndefined();
    const tx = decodeUnsigned(res.unsignedTxBytes);
    expect(tx).toBeInstanceOf(TokenAssociateTransaction);
    expect(tx.isFrozen()).toBe(true);
    expect(res.transactionId).toMatch(/^0\.0\.555@\d+\.\d+$/);
  });

  it("short-circuits when already associated", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes(`/tokens/${TOKEN_ID}`) && !url.includes("/nfts")) return ok(tokenJson());
      if (url.includes("/accounts/")) return ok({ tokens: [{ token_id: TOKEN_ID }] });
      throw new Error("unexpected " + url);
    }) as unknown as typeof fetch;
    const res = await withCtx(() =>
      prepareNftAssociation({ account_id: "0.0.555", token_id: TOKEN_ID }, deps({ fetchFn })),
    );
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.alreadyAssociated).toBe(true);
    expect(res.unsignedTxBytes).toBe("");
  });

  it("validates account and token formats", async () => {
    const bad = await withCtx(() =>
      prepareNftAssociation({ account_id: "abc", token_id: TOKEN_ID }, deps()),
    );
    expect("error" in bad && bad.error).toMatch(/account_id/);
  });
});
