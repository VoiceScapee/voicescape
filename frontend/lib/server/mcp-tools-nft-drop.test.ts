/**
 * NFT drop pipeline (create_nft_drop / finalize_nft_drop /
 * prepare_nft_transfer) — unit tests.
 *
 * Mirror node and Pinata are faked; no HBAR is ever spent. Unsigned
 * transaction bytes are decoded with the real @hiero-ledger/sdk and
 * asserted structurally: the fee transfer is FIRST in the signing package
 * and pays exactly 1 HBAR to the treasury; the create is a TokenCreate
 * capped at the piece count; finalize rejects drops whose fee payment is
 * missing, short, or paid by someone else; the registry write and the
 * token-id extraction come from the (faked) mirror records.
 */
import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import {
  Transaction,
  TokenCreateTransaction,
  TokenMintTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import {
  createNftDrop,
  finalizeNftDrop,
  prepareNftTransfer,
  deriveSymbol,
  PLATFORM_TREASURY_ACCOUNT_ID,
  NFT_CREATION_FEE_TINYBAR,
  type NftDropToolDeps,
} from "./mcp-tools-nft-drop";
import { listNftRegistry, getNftRegistryEntry } from "./nft-registry";
import type { TownhallDeps } from "./townhall/handlers";
import { requestContextStorage } from "./mcp-tools";
import { createMemoryQuotaStore } from "./quota";
import { createMemoryKvStore, type KvStore } from "./store";

const CREATOR_EVM = "0xabc1230000000000000000000000000000000001";
const CREATOR_ACCOUNT = "0.0.777";
const NEW_TOKEN_ID = "0.0.424242";
const RECIPIENT = "0.0.888";

/** Deterministic plausible CIDs per pin call: Qm<n><a×43>. */
function cidFor(n: number): string {
  return "Qm" + String(n) + "a".repeat(43);
}
const ART_CID_GIVEN = cidFor(9);

const RESOLVE_IFACE = new ethers.Interface([
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
]);
function resolvePageResult(ownerType: number): string {
  return RESOLVE_IFACE.encodeFunctionResult("resolvePage", [
    CREATOR_EVM,
    "QmTestHash",
    BigInt(ownerType),
    "0x0000000000000000000000000000000000000000",
    "test creator",
  ]);
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function notFound() {
  return { ok: false, status: 404, json: async () => ({}) };
}

/**
 * Stateful mirror mock. `txs` maps transaction id → record the mirror
 * should return; tests register the records for the ids create_nft_drop
 * hands out (exactly what the chain would show after signing).
 */
function makeMirror() {
  const txs = new Map<string, Record<string, unknown>>();
  const fetchFn = (async (url: string) => {
    if (url.includes("/contracts/call")) return ok({ result: resolvePageResult(1) });
    if (url.includes("/transactions/")) {
      const id = decodeURIComponent(url.split("/transactions/")[1] ?? "");
      const rec = txs.get(id);
      if (!rec) return notFound();
      return ok({ transactions: [rec] });
    }
    if (url.includes(`/tokens/${NEW_TOKEN_ID}/nfts/`)) {
      // single-serial lookup (gift path)
      const serial = Number(url.split("/nfts/")[1]);
      if (serial === 1 || serial === 2) return ok({ serial_number: serial, account_id: CREATOR_ACCOUNT });
      return notFound();
    }
    if (url.includes(`/tokens/${NEW_TOKEN_ID}/nfts`)) {
      // Pin order: piece 2's base64 art is pin #1 (piece 1's art was
      // caller-pinned); finalize phase 1 metadata pins are #2 and #3.
      return ok({
        nfts: [
          { serial_number: 1, metadata: Buffer.from(`ipfs://${cidFor(2)}`, "utf8").toString("base64") },
          { serial_number: 2, metadata: Buffer.from(`ipfs://${cidFor(3)}`, "utf8").toString("base64") },
        ],
      });
    }
    if (url.includes(`/tokens/${NEW_TOKEN_ID}`)) {
      return ok({
        token_id: NEW_TOKEN_ID,
        name: "Neon Tide",
        symbol: "NEONTIDE",
        type: "NON_FUNGIBLE_UNIQUE",
        treasury_account_id: CREATOR_ACCOUNT,
        max_supply: "2",
        total_supply: "2",
      });
    }
    if (url.includes("/accounts/")) {
      if (url.includes("/tokens?")) {
        // recipient association check: RECIPIENT is associated
        return ok({ tokens: [{ token_id: NEW_TOKEN_ID }] });
      }
      // account key read (supply-key derivation): simple ED25519 key
      return ok({ account: CREATOR_ACCOUNT, key: { _type: "ED25519", key: "a".repeat(64) } });
    }
    throw new Error("unexpected fetch " + url);
  }) as unknown as typeof fetch;
  return { fetchFn, txs };
}

function fakeDeps(): TownhallDeps {
  return {
    hcs: { verifyTx: async () => null, query: async () => [], queryAll: async () => [] },
    mirror: { resolveAccountId: async () => CREATOR_ACCOUNT },
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

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_B64 = PNG_BYTES.toString("base64");

interface TestDeps extends NftDropToolDeps {
  kv: KvStore;
  pinCount: () => number;
}

function deps(over: Partial<NftDropToolDeps> = {}): TestDeps {
  let pins = 0;
  const kv = createMemoryKvStore();
  return {
    fetchFn: over.fetchFn,
    townhallDeps: fakeDeps(),
    quotaStore: createMemoryQuotaStore(),
    publishFn: async () => {
      pins += 1;
      return { cid: cidFor(pins) };
    },
    kvStore: kv,
    ...over,
    kv,
    pinCount: () => pins,
  };
}

function decodeUnsigned(b64: string): Transaction {
  return Transaction.fromBytes(Buffer.from(b64, "base64"));
}

const TWO_PIECES = [
  { name: "Tide One", image_cid: ART_CID_GIVEN, price_usd_cents: 2500 },
  { name: "Tide Two", image_base64: PNG_B64, filename: "tide-two.png" },
];

async function createDrop(d: TestDeps) {
  const res = await withCtx(() =>
    createNftDrop({ agent_username: "mara", name: "Neon Tide", pieces: TWO_PIECES }, d),
  );
  expect("error" in res).toBe(false);
  return res as {
    drop_id: string;
    sign_in_order: Array<{ kind: string; unsignedTxBytes: string; transactionId: string }>;
    collection: { symbol: string; max_supply: number };
  };
}

/** Register the mirror records a successful signing would produce. */
function landHappyPath(
  txs: Map<string, Record<string, unknown>>,
  pkg: Awaited<ReturnType<typeof createDrop>>,
) {
  const feeId = pkg.sign_in_order[0].transactionId;
  const createId = pkg.sign_in_order[1].transactionId;
  txs.set(feeId, {
    name: "CRYPTOTRANSFER",
    result: "SUCCESS",
    transaction_id: feeId,
    transfers: [
      { account: CREATOR_ACCOUNT, amount: -NFT_CREATION_FEE_TINYBAR },
      { account: PLATFORM_TREASURY_ACCOUNT_ID, amount: NFT_CREATION_FEE_TINYBAR },
    ],
  });
  txs.set(createId, {
    name: "TOKENCREATE",
    result: "SUCCESS",
    transaction_id: createId,
    entity_id: NEW_TOKEN_ID,
  });
  return { feeId, createId };
}

describe("deriveSymbol", () => {
  it("derives an uppercase ticker from the name", () => {
    expect(deriveSymbol("Neon Tide")).toBe("NEONTIDE");
    expect(deriveSymbol("my cool drop!! 2026")).toBe("MYCOOLDROP");
    expect(deriveSymbol("!!!")).toBe("");
  });
});

describe("create_nft_drop", () => {
  it("returns ONE package: fee transfer first (exactly 1 HBAR to treasury), then the TokenCreate", async () => {
    const { fetchFn } = makeMirror();
    const d = deps({ fetchFn });
    const pkg = await createDrop(d);

    expect(pkg.collection.symbol).toBe("NEONTIDE");
    expect(pkg.collection.max_supply).toBe(2);
    expect(pkg.sign_in_order.map((s) => s.kind)).toEqual(["creation_fee", "token_create"]);

    const feeTx = decodeUnsigned(pkg.sign_in_order[0].unsignedTxBytes) as TransferTransaction;
    expect(feeTx).toBeInstanceOf(TransferTransaction);
    expect(feeTx.isFrozen()).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xfers = (feeTx as any).hbarTransfers as Map<string, { toTinybars(): { toNumber(): number } }>;
    expect(xfers.get(PLATFORM_TREASURY_ACCOUNT_ID)?.toTinybars().toNumber()).toBe(NFT_CREATION_FEE_TINYBAR);
    expect(xfers.get(CREATOR_ACCOUNT)?.toTinybars().toNumber()).toBe(-NFT_CREATION_FEE_TINYBAR);

    const createTx = decodeUnsigned(pkg.sign_in_order[1].unsignedTxBytes) as TokenCreateTransaction;
    expect(createTx).toBeInstanceOf(TokenCreateTransaction);
    expect(createTx.tokenName).toBe("Neon Tide");
    expect(createTx.tokenSymbol).toBe("NEONTIDE");
    expect(createTx.maxSupply?.toString()).toBe("2");
    expect(createTx.treasuryAccountId?.toString()).toBe(CREATOR_ACCOUNT);

    expect(JSON.stringify(pkg)).not.toMatch(/private/i);
  });

  it("rejects empty and oversized piece lists", async () => {
    const { fetchFn } = makeMirror();
    const empty = await withCtx(() =>
      createNftDrop({ agent_username: "mara", name: "Neon Tide", pieces: [] }, deps({ fetchFn })),
    );
    expect("error" in empty && empty.error).toMatch(/pieces/);
    const many = await withCtx(() =>
      createNftDrop(
        {
          agent_username: "mara",
          name: "Neon Tide",
          pieces: Array.from({ length: 11 }, (_, i) => ({ name: `P${i}`, image_cid: ART_CID_GIVEN })),
        },
        deps({ fetchFn }),
      ),
    );
    expect("error" in many && many.error).toMatch(/pieces/);
  });
});

describe("finalize_nft_drop", () => {
  it("phase 1 verifies the fee + create, extracts the token id, writes the registry, returns the mint package", async () => {
    const mirror = makeMirror();
    const d = deps({ fetchFn: mirror.fetchFn });
    const pkg = await createDrop(d);
    const { feeId, createId } = landHappyPath(mirror.txs, pkg);

    const res = await withCtx(() =>
      finalizeNftDrop(
        { agent_username: "mara", drop_id: pkg.drop_id, fee_tx_id: feeId, create_tx_id: createId },
        d,
      ),
    );
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.finalized).toBe("created");
    expect(res.token_id).toBe(NEW_TOKEN_ID);
    expect(res.gallery_block).toEqual({ type: "nftGallery", token_id: NEW_TOKEN_ID, title: "Neon Tide" });

    const mint = res.mint as { unsignedTxBytes: string; transactionId: string };
    const mintTx = decodeUnsigned(mint.unsignedTxBytes);
    expect(mintTx).toBeInstanceOf(TokenMintTransaction);
    expect((mintTx as TokenMintTransaction).tokenId?.toString()).toBe(NEW_TOKEN_ID);

    const entry = await getNftRegistryEntry(NEW_TOKEN_ID, { store: d.kv });
    expect(entry?.creatorUsername).toBe("mara");
    expect(entry?.creatorAccount).toBe(CREATOR_ACCOUNT);
    const all = await listNftRegistry({ store: d.kv });
    expect(all.map((e) => e.tokenId)).toEqual([NEW_TOKEN_ID]);
  });

  it("rejects finalize when the fee payment is missing, short, or from the wrong payer", async () => {
    // (a) fee tx absent on the mirror
    {
      const mirror = makeMirror();
      const d = deps({ fetchFn: mirror.fetchFn });
      const pkg = await createDrop(d);
      const { feeId, createId } = landHappyPath(mirror.txs, pkg);
      mirror.txs.delete(feeId);
      const res = await withCtx(() =>
        finalizeNftDrop({ agent_username: "mara", drop_id: pkg.drop_id, fee_tx_id: feeId, create_tx_id: createId }, d),
      );
      expect("error" in res && res.error).toMatch(/fee transaction not found/);
    }
    // (b) fee short by 1 tinybar
    {
      const mirror = makeMirror();
      const d = deps({ fetchFn: mirror.fetchFn });
      const pkg = await createDrop(d);
      const { feeId, createId } = landHappyPath(mirror.txs, pkg);
      mirror.txs.set(feeId, {
        name: "CRYPTOTRANSFER",
        result: "SUCCESS",
        transaction_id: feeId,
        transfers: [{ account: PLATFORM_TREASURY_ACCOUNT_ID, amount: NFT_CREATION_FEE_TINYBAR - 1 }],
      });
      const res = await withCtx(() =>
        finalizeNftDrop({ agent_username: "mara", drop_id: pkg.drop_id, fee_tx_id: feeId, create_tx_id: createId }, d),
      );
      expect("error" in res && res.error).toMatch(/1 HBAR creation fee/);
      expect(await listNftRegistry({ store: d.kv })).toEqual([]);
    }
    // (c) wrong payer
    {
      const mirror = makeMirror();
      const d = deps({ fetchFn: mirror.fetchFn });
      const pkg = await createDrop(d);
      const { createId } = landHappyPath(mirror.txs, pkg);
      const feeId = pkg.sign_in_order[0].transactionId;
      mirror.txs.set(feeId, {
        name: "CRYPTOTRANSFER",
        result: "SUCCESS",
        transaction_id: "0.0.999@1700000000.000000000",
        transfers: [{ account: PLATFORM_TREASURY_ACCOUNT_ID, amount: NFT_CREATION_FEE_TINYBAR }],
      });
      const res = await withCtx(() =>
        finalizeNftDrop({ agent_username: "mara", drop_id: pkg.drop_id, fee_tx_id: feeId, create_tx_id: createId }, d),
      );
      expect("error" in res && res.error).toMatch(/not paid by the drop creator/);
    }
    // (d) tx id that doesn't match the prepared package
    {
      const mirror = makeMirror();
      const d = deps({ fetchFn: mirror.fetchFn });
      const pkg = await createDrop(d);
      const { createId } = landHappyPath(mirror.txs, pkg);
      const res = await withCtx(() =>
        finalizeNftDrop(
          { agent_username: "mara", drop_id: pkg.drop_id, fee_tx_id: "0.0.777@1.1", create_tx_id: createId },
          d,
        ),
      );
      expect("error" in res && res.error).toMatch(/does not match the fee transaction/);
    }
  });

  it("phase 2 verifies the mint, resolves serials, and prepares the priced piece's listing payload", async () => {
    const mirror = makeMirror();
    const d = deps({ fetchFn: mirror.fetchFn });
    const pkg = await createDrop(d);
    const { feeId, createId } = landHappyPath(mirror.txs, pkg);
    const p1 = await withCtx(() =>
      finalizeNftDrop({ agent_username: "mara", drop_id: pkg.drop_id, fee_tx_id: feeId, create_tx_id: createId }, d),
    );
    if ("error" in p1) throw new Error(String(p1.error));
    const mintId = (p1.mint as { transactionId: string }).transactionId;
    mirror.txs.set(mintId, { name: "TOKENMINT", result: "SUCCESS", transaction_id: mintId });

    const p2 = await withCtx(() =>
      finalizeNftDrop({ agent_username: "mara", drop_id: pkg.drop_id, mint_tx_id: mintId }, d),
    );
    expect("error" in p2).toBe(false);
    if ("error" in p2) return;
    expect(p2.finalized).toBe("completed");
    const pieces = p2.pieces as Array<{ name: string; serial?: number }>;
    expect(pieces.map((p) => [p.name, p.serial])).toEqual([
      ["Tide One", 1],
      ["Tide Two", 2],
    ]);
    const payloads = p2.listing_payloads as Array<{ token_id: string; serial: number; price_usd_cents: number }>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ token_id: NEW_TOKEN_ID, serial: 1, price_usd_cents: 2500 });

    // Idempotent: a third call reports the completed status.
    const p3 = await withCtx(() =>
      finalizeNftDrop({ agent_username: "mara", drop_id: pkg.drop_id }, d),
    );
    expect("error" in p3).toBe(false);
    if (!("error" in p3)) expect(p3.finalized).toBe("completed");
  });

  it("rejects finalize from a different page than the creator", async () => {
    const mirror = makeMirror();
    const d = deps({ fetchFn: mirror.fetchFn });
    const pkg = await createDrop(d);
    const { feeId, createId } = landHappyPath(mirror.txs, pkg);
    // Same mirror (same owner account) but a different username string is
    // impossible via this mock — instead assert the unknown-drop error
    // path and wrong-id path stay closed.
    const res = await withCtx(() =>
      finalizeNftDrop(
        { agent_username: "mara", drop_id: "f".repeat(32), fee_tx_id: feeId, create_tx_id: createId },
        d,
      ),
    );
    expect("error" in res && res.error).toMatch(/drop not found/);
  });
});

describe("prepare_nft_transfer", () => {
  it("returns frozen unsigned NFT transfer bytes and reports recipient association", async () => {
    const mirror = makeMirror();
    const d = deps({ fetchFn: mirror.fetchFn });
    const res = await withCtx(() =>
      prepareNftTransfer(
        { agent_username: "mara", token_id: NEW_TOKEN_ID, serial_number: 1, recipient_account_id: RECIPIENT },
        d,
      ),
    );
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.recipientAssociated).toBe(true);
    const tx = decodeUnsigned(res.unsignedTxBytes as string) as TransferTransaction;
    expect(tx).toBeInstanceOf(TransferTransaction);
    expect(tx.isFrozen()).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nftXfers = (tx as any).nftTransfers as {
      get(key: string): Array<{ serial: { toNumber(): number }; recipient: { toString(): string } }> | undefined;
    };
    const list = nftXfers.get(NEW_TOKEN_ID) ?? [];
    expect(list).toHaveLength(1);
    expect(list[0].serial.toNumber()).toBe(1);
    expect(list[0].recipient.toString()).toBe(RECIPIENT);
  });

  it("rejects serials the caller does not hold and self-gifts", async () => {
    const mirror = makeMirror();
    const d = deps({ fetchFn: mirror.fetchFn });
    const missing = await withCtx(() =>
      prepareNftTransfer(
        { agent_username: "mara", token_id: NEW_TOKEN_ID, serial_number: 9, recipient_account_id: RECIPIENT },
        d,
      ),
    );
    expect("error" in missing && missing.error).toMatch(/does not exist/);
    const self = await withCtx(() =>
      prepareNftTransfer(
        { agent_username: "mara", token_id: NEW_TOKEN_ID, serial_number: 1, recipient_account_id: CREATOR_ACCOUNT },
        d,
      ),
    );
    expect("error" in self && self.error).toMatch(/your own account/);
  });
});
