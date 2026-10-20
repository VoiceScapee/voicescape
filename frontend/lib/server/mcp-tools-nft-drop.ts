/**
 * Voicescape NFT builder — the v2 one-shot drop pipeline.
 *
 * create_nft_drop → finalize_nft_drop replaces the old three-step
 * prepare-collection / prepare-mint / paste-the-token-id dance with ONE
 * signing package and a server-side finalize:
 *
 *   create_nft_drop   Pins the artwork, derives the ticker from the name,
 *                     and returns ONE package to sign in order:
 *                       1. the 1 HBAR Voicescape creation fee transfer
 *                          (to the platform treasury), then
 *                       2. the HTS TokenCreate (treasury / supply / admin
 *                          = the creator's own account).
 *                     A frozen TokenMint CANNOT be pre-built here — the
 *                     token id doesn't exist until the create lands — so
 *                     the mint package is produced by finalize, below.
 *   finalize_nft_drop Stateful, called twice:
 *                       Phase 1 (fee_tx_id + create_tx_id): verifies BOTH
 *                       transactions on the mirror node — the fee actually
 *                       reached the treasury, the create actually landed —
 *                       reads the new token id out of the create record,
 *                       writes the NFT registry entry, pins the HIP-412
 *                       metadata for every piece (now that the token id is
 *                       known), and returns the mint package (ONE
 *                       TokenMint carrying every piece) plus the
 *                       nftGallery block to attach to the creator's page.
 *                       Phase 2 (mint_tx_id): verifies the mint, resolves
 *                       each piece's serial from the mirror node, and — for
 *                       priced pieces — prepares marketplace listings
 *                       through create_listing step 1 (agent pages; the
 *                       human builder lists through the web sell flow).
 *   prepare_nft_transfer  Unsigned TokenTransfer bytes for gifting one
 *                     serial. The owner signs; the server never does.
 *
 * Money rules (unchanged platform invariants): the server NEVER holds or
 * signs with user keys; creators pay all Hedera network fees from their
 * own wallets; the ONLY platform revenue here is the 1 HBAR creation fee
 * (+ the existing 2% on later sales through the Tips contract). Nothing
 * is escrowed. Creation is never "free" — the fee and the network costs
 * are stated in every result.
 *
 * ⚠ NEEDS-HUMAN-REVIEW: this module builds the fee-collecting transaction
 * (the 1 HBAR transfer to the treasury). Per standing policy, fee code
 * paths are flagged for human review before merge.
 */
import {
  AccountId,
  Hbar,
  TokenId,
  TokenMintTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { randomBytes } from "node:crypto";
import {
  ACCOUNT_ID_RE,
  TOKEN_ID_RE,
  fetchMirrorToken,
  freezeUnsigned,
  ipRateLimit,
  pinNftArtwork,
  pinNftMetadata,
  prepareQuota,
  prepareNftCollection,
  resolvePageOwner,
  restrictionError,
  type NftFetchFn,
  type NftToolDeps,
} from "./mcp-tools-nft";
import { createListingTool } from "./mcp-tools-marketplace";
import { checkContent } from "./townhall/content-filter";
import { defaultDeps } from "./townhall/handlers";
import { globalQuotaStore } from "./quota";
import { publishDigitalGood } from "./publish.js";
import { getKvStore, type KvStore } from "./store";
import { registerNftCollection } from "./nft-registry";

/** Platform treasury — the same account that receives the Tips 2% cut. */
export const PLATFORM_TREASURY_ACCOUNT_ID = "0.0.10424063";
/** The Voicescape creation fee: exactly 1 HBAR, in tinybar. */
export const NFT_CREATION_FEE_TINYBAR = 100_000_000;
/** Batch mint + registry sanity: a drop is 1–10 pieces, one NFT each. */
export const MAX_DROP_PIECES = 10;
/** Drop records live 7 days — long enough to finish signing, not forever. */
const DROP_TTL_MS = 7 * 24 * 3_600_000;
const MIRROR_API = "https://mainnet.mirrornode.hedera.com/api/v1";
const HASHSCAN_TOKEN = "https://hashscan.io/mainnet/token";
const MAX_PIECE_NAME = 100;
const MAX_PIECE_DESCRIPTION = 1000;
const MAX_COLLECTION_NAME = 100;

const DROP_KEY_PREFIX = "nft-drops:";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface NftDropPiece {
  name: string;
  description?: string;
  /** IPFS CID of the artwork (pinned at create time or caller-supplied). */
  artCid: string;
  artMime: string;
  /** Optional asking price in USD cents — listed at finalize phase 2. */
  priceUsdCents?: number;
  /** Filled at finalize phase 1 (metadata needs the token id). */
  metadataCid?: string;
  metadataUri?: string;
  /** Filled at finalize phase 2 from the mirror node. */
  serial?: number;
}

export interface NftDropRecord {
  dropId: string;
  username: string;
  creatorAccount: string;
  creatorWallet: string;
  name: string;
  symbol: string;
  pieces: NftDropPiece[];
  feeTxId: string;
  createTxId: string;
  tokenId?: string;
  mintTxId?: string;
  mintUnsignedTxBytes?: string;
  state: "prepared" | "created" | "completed";
  createdAt: number;
}

export interface NftDropToolDeps extends NftToolDeps {
  /** KV store for drop records (tests inject an in-memory store). */
  kvStore?: KvStore;
}

function dropStore(deps: NftDropToolDeps): KvStore {
  return deps.kvStore ?? getKvStore();
}

async function saveDrop(store: KvStore, record: NftDropRecord): Promise<void> {
  await store.set(DROP_KEY_PREFIX + record.dropId, JSON.stringify(record), DROP_TTL_MS);
}

async function loadDrop(store: KvStore, dropId: string): Promise<NftDropRecord | null> {
  const raw = await store.get(DROP_KEY_PREFIX + dropId);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as NftDropRecord;
    return parsed && typeof parsed.dropId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Mirror helpers                                                      */
/* ------------------------------------------------------------------ */

interface MirrorTx {
  name?: string;
  result?: string;
  transaction_id?: string;
  entity_id?: string | null;
  transfers?: Array<{ account?: string; amount?: number }>;
}

/** Fetch one transaction record from the mirror node. Null when absent. */
async function fetchMirrorTx(
  txId: string,
  fetchFn: NftFetchFn,
): Promise<MirrorTx | null> {
  const res = await fetchFn(`${MIRROR_API}/transactions/${encodeURIComponent(txId)}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`mirror node returned ${res.status}`);
  const body = (await res.json()) as { transactions?: MirrorTx[] } & MirrorTx;
  return body?.transactions?.[0] ?? (body as MirrorTx) ?? null;
}

/**
 * Verify the creation-fee transaction: a SUCCESS CRYPTOTRANSFER, paid BY
 * the creator, paying the treasury at least the 1 HBAR fee. Anything less
 * fails closed — the registry write depends on this check.
 */
export function verifyFeeTx(
  tx: MirrorTx | null,
  creatorAccount: string,
): { ok: true } | { error: string } {
  if (!tx) {
    return { error: "fee transaction not found on the mirror node yet — wait a few seconds after submitting and retry" };
  }
  if (tx.name !== "CRYPTOTRANSFER" || tx.result !== "SUCCESS") {
    return { error: `fee transaction did not succeed on-chain (name ${tx.name ?? "?"}, result ${tx.result ?? "?"})` };
  }
  if (!tx.transaction_id || !tx.transaction_id.startsWith(`${creatorAccount}@`)) {
    return { error: "fee transaction was not paid by the drop creator's account" };
  }
  const toTreasury = (tx.transfers ?? []).find((t) => t.account === PLATFORM_TREASURY_ACCOUNT_ID);
  if (!toTreasury || typeof toTreasury.amount !== "number" || toTreasury.amount < NFT_CREATION_FEE_TINYBAR) {
    return {
      error: `fee transaction does not pay the 1 HBAR creation fee to the Voicescape treasury (${PLATFORM_TREASURY_ACCOUNT_ID})`,
    };
  }
  return { ok: true };
}

/** Derive a token symbol from a collection name: A–Z0–9, ≤10 chars. */
export function deriveSymbol(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* create_nft_drop                                                     */
/* ------------------------------------------------------------------ */

export interface CreateNftDropPieceArgs {
  name: string;
  description?: string;
  image_cid?: string;
  image_base64?: string;
  filename?: string;
  image_mime?: string;
  price_usd_cents?: number;
}

export interface CreateNftDropArgs {
  agent_username: string;
  name: string;
  /** Optional — defaults to the page-owner account's on-chain key. */
  supply_public_key?: string;
  pieces: CreateNftDropPieceArgs[];
}

/** Read the account's simple public key from the mirror node (when the
 *  caller doesn't pass supply_public_key). Null for key lists/thresholds. */
async function mirrorAccountPublicKey(
  accountId: string,
  fetchFn: NftFetchFn,
): Promise<string | null> {
  try {
    const res = await fetchFn(`${MIRROR_API}/accounts/${encodeURIComponent(accountId)}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { key?: { key?: unknown } };
    const k = body?.key?.key;
    return typeof k === "string" && k.length > 0 ? k : null;
  } catch {
    return null;
  }
}

export async function createNftDrop(
  args: CreateNftDropArgs,
  injected: NftDropToolDeps = {},
): Promise<Record<string, unknown>> {
  const fetchFn = injected.fetchFn ?? fetch;
  const deps = injected.townhallDeps ?? defaultDeps();
  const quotaStore = injected.quotaStore ?? globalQuotaStore();
  const publishFn = injected.publishFn ?? publishDigitalGood;
  const store = dropStore(injected);

  if (!args || typeof args !== "object") return { error: "arguments are required" };

  const limited = await ipRateLimit("mcp-nft", 30, 60_000);
  if (limited) return { error: limited };

  const identity = await resolvePageOwner(args.agent_username, fetchFn);
  if ("error" in identity) return identity;

  const restricted = await restrictionError(deps, identity.wallet);
  if (restricted) return { error: restricted };

  // ── Collection name → symbol ──
  const name = (args.name ?? "").toString().trim();
  if (name.length < 3 || name.length > MAX_COLLECTION_NAME) {
    return { error: `name must be 3–${MAX_COLLECTION_NAME} characters` };
  }
  const nameGate = checkContent(name, "collection name");
  if (!nameGate.allowed) return { error: nameGate.reason ?? "collection name blocked by safety filter" };
  const symbol = deriveSymbol(name);
  if (!symbol) {
    return { error: "collection name needs at least one letter or digit — the token ticker is derived from it" };
  }

  // ── Pieces ──
  if (!Array.isArray(args.pieces) || args.pieces.length < 1 || args.pieces.length > MAX_DROP_PIECES) {
    return { error: `pieces must list 1–${MAX_DROP_PIECES} artworks (one NFT per piece)` };
  }
  const pieces: NftDropPiece[] = [];
  for (let i = 0; i < args.pieces.length; i++) {
    const p = args.pieces[i] ?? ({} as CreateNftDropPieceArgs);
    const pieceName = (p.name ?? "").toString().trim();
    if (pieceName.length < 1 || pieceName.length > MAX_PIECE_NAME) {
      return { error: `pieces[${i}].name must be 1–${MAX_PIECE_NAME} characters` };
    }
    const pieceDesc = (p.description ?? "").toString().trim();
    if (pieceDesc.length > MAX_PIECE_DESCRIPTION) {
      return { error: `pieces[${i}].description must be ≤${MAX_PIECE_DESCRIPTION} characters` };
    }
    for (const [label, text] of [[`pieces[${i}] name`, pieceName], [`pieces[${i}] description`, pieceDesc]] as const) {
      if (!text) continue;
      const gate = checkContent(text, label);
      if (!gate.allowed) return { error: gate.reason ?? `${label} blocked by safety filter` };
    }
    let priceUsdCents: number | undefined;
    if (p.price_usd_cents !== undefined && p.price_usd_cents !== null) {
      const n = Number(p.price_usd_cents);
      if (!Number.isInteger(n) || n <= 0) {
        return { error: `pieces[${i}].price_usd_cents must be a positive integer (USD cents) when set` };
      }
      priceUsdCents = n;
    }
    const art = await pinNftArtwork(p, identity, quotaStore, publishFn);
    if ("error" in art) return { error: `pieces[${i}]: ${art.error}` };
    pieces.push({
      name: pieceName,
      ...(pieceDesc ? { description: pieceDesc } : {}),
      artCid: art.artCid,
      artMime: art.artMime,
      ...(priceUsdCents !== undefined ? { priceUsdCents } : {}),
    });
  }

  // ── Supply key: explicit, else the account's own on-chain key ──
  let supplyPublicKey = (args.supply_public_key ?? "").toString().trim();
  if (!supplyPublicKey) {
    const derived = await mirrorAccountPublicKey(identity.accountId, fetchFn);
    if (!derived) {
      return {
        error:
          "could not read a simple public key for your account from the mirror node (key list / threshold accounts need an explicit key) — pass supply_public_key",
      };
    }
    supplyPublicKey = derived;
  }

  // ── The create transaction (existing machinery: treasury/supply/admin
  //    = creator, FINITE supply capped at the piece count) ──
  const create = await prepareNftCollection(
    {
      agent_username: identity.username,
      name,
      symbol,
      max_supply: pieces.length,
      supply_public_key: supplyPublicKey,
    },
    injected,
  );
  if ("error" in create) return create;

  // ── The fee transaction: exactly 1 HBAR, creator → treasury ──
  const dropId = randomBytes(16).toString("hex");
  const feeTx = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(identity.accountId), Hbar.fromTinybars(-NFT_CREATION_FEE_TINYBAR))
    .addHbarTransfer(AccountId.fromString(PLATFORM_TREASURY_ACCOUNT_ID), Hbar.fromTinybars(NFT_CREATION_FEE_TINYBAR))
    .setMaxTransactionFee(new Hbar(1))
    .setTransactionMemo(`Voicescape NFT creation fee: ${name}`.slice(0, 100));
  const fee = freezeUnsigned(feeTx, identity.accountId);

  const record: NftDropRecord = {
    dropId,
    username: identity.username,
    creatorAccount: identity.accountId,
    creatorWallet: identity.wallet,
    name,
    symbol,
    pieces,
    feeTxId: fee.transactionId,
    createTxId: create.transactionId,
    state: "prepared",
    createdAt: Date.now(),
  };
  try {
    await saveDrop(store, record);
  } catch (e) {
    console.error(`[nft-drop] drop record save failed: ${e instanceof Error ? e.message : String(e)}`);
    return { error: "temporarily unavailable — please retry in a moment" };
  }

  return {
    prepared: true,
    drop_id: dropId,
    collection: { name, symbol, max_supply: pieces.length, treasury: identity.accountId },
    sign_in_order: [
      {
        step: 1,
        kind: "creation_fee",
        unsignedTxBytes: fee.unsignedTxBytes,
        transactionId: fee.transactionId,
        detail: "1 HBAR Voicescape creation fee to the platform treasury",
      },
      {
        step: 2,
        kind: "token_create",
        unsignedTxBytes: create.unsignedTxBytes,
        transactionId: create.transactionId,
        detail: "Creates the HTS NFT collection — you are treasury, supply key, and admin",
      },
    ],
    cost_summary: {
      voicescape_creation_fee_hbar: 1,
      hedera_network_fees:
        "Paid from YOUR wallet on top of the fee: a few HBAR to create the collection, plus a fraction of a cent per mint. The platform pays nothing.",
      total_note:
        "One total from your wallet: 1 HBAR creation fee + Hedera network fees. Nothing here is free, and nothing is escrowed — you own the collection outright.",
    },
    pieces: pieces.map((p) => ({
      name: p.name,
      artCid: p.artCid,
      ...(p.priceUsdCents !== undefined ? { price_usd_cents: p.priceUsdCents } : {}),
    })),
    instructions:
      `Sign BOTH transactions with YOUR wallet key, in order, and submit each to Hedera (frozen Hedera transactions expire ~2 minutes after preparation — if they lapse, call create_nft_drop again). ` +
      `Then call finalize_nft_drop with agent_username "${identity.username}", drop_id "${dropId}", fee_tx_id and create_tx_id set to the transactionIds above. ` +
      `Finalize verifies the fee and the creation on the mirror node, registers the collection, and returns the mint package for all ${pieces.length} piece(s) — a mint transaction cannot be pre-built before the token exists, which is why it comes from finalize. ` +
      `Cost honesty: the 1 HBAR fee is the platform's only creation revenue; every Hedera network fee is paid from your wallet. No escrow, no custody — the server never sees your key.`,
  };
}

/* ------------------------------------------------------------------ */
/* finalize_nft_drop                                                   */
/* ------------------------------------------------------------------ */

export interface FinalizeNftDropArgs {
  agent_username: string;
  drop_id: string;
  fee_tx_id?: string;
  create_tx_id?: string;
  mint_tx_id?: string;
  /**
   * When false, phase 2 returns listing payloads without preparing
   * marketplace submissions (the human builder lists through the web
   * sell flow instead). Defaults to true.
   */
  prepare_listings?: boolean;
}

function galleryBlock(record: NftDropRecord): Record<string, unknown> {
  return { type: "nftGallery", token_id: record.tokenId, title: record.name };
}

export async function finalizeNftDrop(
  args: FinalizeNftDropArgs,
  injected: NftDropToolDeps = {},
): Promise<Record<string, unknown>> {
  const fetchFn = injected.fetchFn ?? fetch;
  const deps = injected.townhallDeps ?? defaultDeps();
  const quotaStore = injected.quotaStore ?? globalQuotaStore();
  const publishFn = injected.publishFn ?? publishDigitalGood;
  const store = dropStore(injected);

  if (!args || typeof args !== "object") return { error: "arguments are required" };

  const limited = await ipRateLimit("mcp-nft", 30, 60_000);
  if (limited) return { error: limited };

  const identity = await resolvePageOwner(args.agent_username, fetchFn);
  if ("error" in identity) return identity;

  const restricted = await restrictionError(deps, identity.wallet);
  if (restricted) return { error: restricted };

  const dropId = (args.drop_id ?? "").toString().trim();
  if (!/^[0-9a-f]{32}$/.test(dropId)) return { error: "drop_id must be the id returned by create_nft_drop" };
  let record: NftDropRecord | null;
  try {
    record = await loadDrop(store, dropId);
  } catch {
    return { error: "temporarily unavailable — please retry in a moment" };
  }
  if (!record) return { error: "drop not found (records expire after 7 days) — call create_nft_drop again" };
  if (record.creatorAccount !== identity.accountId || record.username !== identity.username) {
    return { error: "this drop belongs to a different blockpage — finalize it as its creator" };
  }

  /* ── Phase 1: verify fee + create, register, build the mint package ── */
  if (record.state === "prepared") {
    const feeTxId = (args.fee_tx_id ?? "").toString().trim();
    const createTxId = (args.create_tx_id ?? "").toString().trim();
    if (!feeTxId || !createTxId) {
      return { error: "phase 1 needs fee_tx_id and create_tx_id (the transactionIds from create_nft_drop)" };
    }
    if (feeTxId !== record.feeTxId) {
      return { error: "fee_tx_id does not match the fee transaction prepared for this drop" };
    }
    if (createTxId !== record.createTxId) {
      return { error: "create_tx_id does not match the TokenCreate prepared for this drop" };
    }

    let feeTx: MirrorTx | null;
    let createTx: MirrorTx | null;
    try {
      feeTx = await fetchMirrorTx(feeTxId, fetchFn);
      createTx = await fetchMirrorTx(createTxId, fetchFn);
    } catch (e) {
      return { error: e instanceof Error ? e.message : "mirror node unreachable — retry in a moment" };
    }
    const feeCheck = verifyFeeTx(feeTx, record.creatorAccount);
    if ("error" in feeCheck) return feeCheck;

    if (!createTx) {
      return { error: "create transaction not found on the mirror node yet — wait a few seconds after submitting and retry" };
    }
    if (createTx.name !== "TOKENCREATE" || createTx.result !== "SUCCESS") {
      return { error: `create transaction did not succeed on-chain (name ${createTx.name ?? "?"}, result ${createTx.result ?? "?"})` };
    }
    const tokenId = (createTx.entity_id ?? "").toString().trim();
    if (!TOKEN_ID_RE.test(tokenId)) {
      return { error: "could not read the new token id from the create transaction record" };
    }

    // Belt-and-braces: the live token must be the creator's NFT collection.
    let token;
    try {
      token = await fetchMirrorToken(tokenId, fetchFn);
    } catch (e) {
      return { error: e instanceof Error ? e.message : "mirror node unreachable — retry in a moment" };
    }
    if (!token) return { error: `token ${tokenId} not visible on the mirror node yet — retry in a moment` };
    if (token.type !== "NON_FUNGIBLE_UNIQUE") {
      return { error: `token ${tokenId} is not an NFT collection (type ${token.type})` };
    }
    if (token.treasury_account_id !== record.creatorAccount) {
      return { error: `token ${tokenId} treasury is not the drop creator — refusing to register it` };
    }

    // Registry write — the collection is real, so it joins the platform
    // index and appears on /nfts.
    try {
      await registerNftCollection(
        {
          tokenId,
          creatorAccount: record.creatorAccount,
          creatorUsername: record.username,
          name: token.name || record.name,
          symbol: token.symbol || record.symbol,
          createdAt: new Date().toISOString(),
        },
        { store },
      );
    } catch (e) {
      console.error(`[nft-drop] registry write failed: ${e instanceof Error ? e.message : String(e)}`);
      return { error: "registry write failed — retry finalize in a moment (your on-chain drop is safe)" };
    }

    // Pin HIP-412 metadata per piece (needs the token id — only possible
    // now), then ONE batch mint carrying every piece.
    const metadataUris: string[] = [];
    for (const piece of record.pieces) {
      const meta = await pinNftMetadata(
        {
          name: piece.name,
          description:
            piece.description || `${piece.name} — from "${record.name}" by ${record.username} on Voicescape`,
          artCid: piece.artCid,
          artMime: piece.artMime,
          creator: record.username,
          collectionName: token.name || record.name,
          tokenId,
          wallet: record.creatorWallet,
        },
        quotaStore,
        publishFn,
      );
      if ("error" in meta) return { error: `metadata for "${piece.name}": ${meta.error}` };
      piece.metadataCid = meta.metadataCid;
      piece.metadataUri = meta.metadataUri;
      metadataUris.push(meta.metadataUri);
    }

    const mintTx = new TokenMintTransaction()
      .setTokenId(TokenId.fromString(tokenId))
      .setMetadata(metadataUris.map((u) => Buffer.from(u, "utf8")))
      // Ceiling only — batch minting a handful of NFTs costs cents at most.
      .setMaxTransactionFee(new Hbar(10))
      .setTransactionMemo(`Voicescape NFT drop mint: ${record.name}`.slice(0, 100));
    const mint = freezeUnsigned(mintTx, record.creatorAccount);

    record.tokenId = tokenId;
    record.mintTxId = mint.transactionId;
    record.mintUnsignedTxBytes = mint.unsignedTxBytes;
    record.state = "created";
    try {
      await saveDrop(store, record);
    } catch {
      return { error: "temporarily unavailable — please retry in a moment" };
    }

    return {
      finalized: "created",
      drop_id: record.dropId,
      token_id: tokenId,
      tokenId,
      name: token.name || record.name,
      symbol: token.symbol || record.symbol,
      hashscanUrl: `${HASHSCAN_TOKEN}/${tokenId}`,
      gallery_block: galleryBlock(record),
      mint: {
        unsignedTxBytes: mint.unsignedTxBytes,
        transactionId: mint.transactionId,
        pieces: record.pieces.length,
        detail: `One TokenMint creating all ${record.pieces.length} piece(s) — sign with your supply key`,
      },
      instructions:
        `Your collection ${tokenId} is live on Hedera and registered — it now appears on the Voicescape /nfts page and the gallery block below shows it on your blockpage. ` +
        `Attach gallery_block to your page (agents: include it in your next page update; the human builder attaches it automatically). ` +
        `Next: sign the mint package with your supply key and submit, then call finalize_nft_drop once more with mint_tx_id "${mint.transactionId}" to resolve serials` +
        (record.pieces.some((p) => p.priceUsdCents !== undefined)
          ? ` and prepare the marketplace listings for your priced pieces.`
          : `.`),
    };
  }

  /* ── Phase 2: verify the mint, resolve serials, prepare listings ── */
  if (record.state === "created") {
    const mintTxId = (args.mint_tx_id ?? "").toString().trim();
    if (!mintTxId) {
      // Status replay: the caller hasn't submitted the mint (or lost the
      // package — frozen bytes expire in ~2 minutes, so point them at
      // the per-piece fallback rather than re-issuing blindly).
      return {
        finalized: "created",
        drop_id: record.dropId,
        token_id: record.tokenId,
        tokenId: record.tokenId,
        gallery_block: galleryBlock(record),
        ...(record.mintUnsignedTxBytes
          ? { mint: { unsignedTxBytes: record.mintUnsignedTxBytes, transactionId: record.mintTxId } }
          : {}),
        instructions:
          `Collection ${record.tokenId} is created and registered. Sign the mint package and submit it, then call finalize_nft_drop with mint_tx_id "${record.mintTxId}". ` +
          `If the frozen mint bytes have expired, mint each piece with prepare_nft_mint instead (same collection, same art CIDs: ${record.pieces.map((p) => p.artCid).join(", ")}).`,
      };
    }
    if (mintTxId !== record.mintTxId) {
      return { error: "mint_tx_id does not match the mint transaction prepared for this drop" };
    }
    let mintTx: MirrorTx | null;
    try {
      mintTx = await fetchMirrorTx(mintTxId, fetchFn);
    } catch (e) {
      return { error: e instanceof Error ? e.message : "mirror node unreachable — retry in a moment" };
    }
    if (!mintTx) {
      return { error: "mint transaction not found on the mirror node yet — wait a few seconds after submitting and retry" };
    }
    if (mintTx.name !== "TOKENMINT" || mintTx.result !== "SUCCESS") {
      return { error: `mint transaction did not succeed on-chain (name ${mintTx.name ?? "?"}, result ${mintTx.result ?? "?"})` };
    }

    // Resolve serials from the live token state: match each piece's
    // pinned metadata URI to the serial carrying it.
    const tokenId = record.tokenId as string;
    let nftsBody: { nfts?: Array<{ serial_number?: number; metadata?: string }> };
    try {
      const res = await fetchFn(`${MIRROR_API}/tokens/${encodeURIComponent(tokenId)}/nfts?limit=100`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`mirror node returned ${res.status}`);
      nftsBody = (await res.json()) as typeof nftsBody;
    } catch (e) {
      return { error: e instanceof Error ? e.message : "mirror node unreachable — retry in a moment" };
    }
    const serialByUri = new Map<string, number>();
    for (const n of nftsBody.nfts ?? []) {
      if (typeof n.serial_number !== "number" || typeof n.metadata !== "string") continue;
      let uri = "";
      try {
        uri = Buffer.from(n.metadata, "base64").toString("utf8");
      } catch {
        uri = "";
      }
      if (uri) serialByUri.set(uri, n.serial_number);
    }
    const unminted: string[] = [];
    for (const piece of record.pieces) {
      const serial = piece.metadataUri ? serialByUri.get(piece.metadataUri) : undefined;
      if (serial === undefined) unminted.push(piece.name);
      else piece.serial = serial;
    }
    if (unminted.length > 0) {
      return {
        error: `mint landed but these pieces are not visible on the mirror node yet: ${unminted.join(", ")} — wait a few seconds and retry finalize`,
      };
    }

    // Listings for priced pieces. Agent pages go through create_listing
    // step 1 (the existing machinery); human pages list through the web
    // sell flow, so for them (and when prepare_listings is false) we hand
    // back the exact payloads instead.
    const prepareListings = args.prepare_listings !== false;
    const listingsToSubmit: unknown[] = [];
    const listingPayloads: unknown[] = [];
    for (const piece of record.pieces) {
      if (piece.priceUsdCents === undefined) continue;
      const payload = {
        title: piece.name.slice(0, 120),
        description:
          `HTS NFT ${tokenId} serial ${piece.serial} — "${piece.name}" from the "${record.name}" collection by ${record.username} on Voicescape. ` +
          `Artwork: ipfs://${piece.artCid}. Pay through the listing: 98% goes to the seller, 2% to the treasury, atomic on-chain via the Tips contract, no escrow. ` +
          `After payment the seller transfers the NFT serial to the buyer peer-to-peer.`,
        price_usd_cents: piece.priceUsdCents,
        goods_type: "digital" as const,
        ipfs_hash: piece.artCid,
        token_id: tokenId,
        serial: piece.serial,
      };
      listingPayloads.push(payload);
      if (prepareListings) {
        const prepared = await createListingTool(
          {
            agent_username: record.username,
            title: payload.title,
            description: payload.description,
            price_usd_cents: payload.price_usd_cents,
            goods_type: "digital",
            ipfs_hash: payload.ipfs_hash,
          },
          injected,
        );
        if ("error" in prepared) {
          // Human pages land here (create_listing is agent-pages-only) —
          // that's not a failure of the drop: the web sell flow lists
          // with the payload above. Only surface it as a note.
          listingsToSubmit.push({ piece: piece.name, serial: piece.serial, skipped: prepared.error });
        } else {
          listingsToSubmit.push({ piece: piece.name, serial: piece.serial, ...prepared });
        }
      }
    }

    record.state = "completed";
    try {
      await saveDrop(store, record);
    } catch {
      return { error: "temporarily unavailable — please retry in a moment" };
    }

    return {
      finalized: "completed",
      drop_id: record.dropId,
      token_id: tokenId,
      tokenId,
      hashscanUrl: `${HASHSCAN_TOKEN}/${tokenId}`,
      gallery_block: galleryBlock(record),
      pieces: record.pieces.map((p) => ({
        name: p.name,
        serial: p.serial,
        artCid: p.artCid,
        metadataUri: p.metadataUri,
        ...(p.priceUsdCents !== undefined ? { price_usd_cents: p.priceUsdCents } : {}),
      })),
      listings_to_submit: listingsToSubmit,
      listing_payloads: listingPayloads,
      instructions:
        `Drop complete: ${record.pieces.length} NFT(s) minted into ${tokenId} and owned by your account. ` +
        (listingsToSubmit.some((l) => typeof l === "object" && l !== null && "listing_id" in (l as Record<string, unknown>))
          ? `For each prepared listing: submit its hcsSubmit.messageJson to the market topic with your wallet, then call create_listing again with hcs_tx_id + listing_id (step 2) to activate it. `
          : ``) +
        (listingPayloads.length > 0
          ? `Human-page creators: list priced pieces from the marketplace sell page using listing_payloads (title, description, price, art CID are filled in there). `
          : ``) +
        `Sales settle through the Tips contract — 98% to you, 2% to the treasury, no escrow; after a sale, transfer the serial to the buyer from your wallet (prepare_nft_transfer builds the unsigned bytes). ` +
        `Unpriced pieces stay in your wallet: keep them, gift them with prepare_nft_transfer, or list them any time.`,
    };
  }

  /* ── Completed: idempotent status ── */
  return {
    finalized: "completed",
    drop_id: record.dropId,
    token_id: record.tokenId,
    tokenId: record.tokenId,
    gallery_block: galleryBlock(record),
    pieces: record.pieces.map((p) => ({ name: p.name, serial: p.serial, artCid: p.artCid })),
    instructions: `This drop already finalized — collection ${record.tokenId} is registered and minted. Nothing left to do here.`,
  };
}

/* ------------------------------------------------------------------ */
/* prepare_nft_transfer                                                */
/* ------------------------------------------------------------------ */

export interface PrepareNftTransferArgs {
  agent_username: string;
  token_id: string;
  serial_number: number;
  recipient_account_id: string;
}

export async function prepareNftTransfer(
  args: PrepareNftTransferArgs,
  injected: NftDropToolDeps = {},
): Promise<Record<string, unknown>> {
  const fetchFn = injected.fetchFn ?? fetch;
  const deps = injected.townhallDeps ?? defaultDeps();

  if (!args || typeof args !== "object") return { error: "arguments are required" };

  const limited = await ipRateLimit("mcp-nft", 30, 60_000);
  if (limited) return { error: limited };

  const identity = await resolvePageOwner(args.agent_username, fetchFn);
  if ("error" in identity) return identity;

  const restricted = await restrictionError(deps, identity.wallet);
  if (restricted) return { error: restricted };

  const qErr = await prepareQuota(injected.quotaStore ?? globalQuotaStore(), identity.wallet);
  if (qErr) return { error: qErr };

  const tokenId = (args.token_id ?? "").toString().trim();
  if (!TOKEN_ID_RE.test(tokenId)) return { error: "token_id must look like 0.0.123456" };
  const serial = Number(args.serial_number);
  if (!Number.isInteger(serial) || serial < 1) {
    return { error: "serial_number must be a positive integer" };
  }
  const recipient = (args.recipient_account_id ?? "").toString().trim();
  if (!ACCOUNT_ID_RE.test(recipient)) {
    return { error: "recipient_account_id must look like 0.0.123456" };
  }
  if (recipient === identity.accountId) {
    return { error: "recipient is your own account — a gift needs a different recipient" };
  }

  let token;
  try {
    token = await fetchMirrorToken(tokenId, fetchFn);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "mirror node unreachable — retry in a moment" };
  }
  if (!token) return { error: `token ${tokenId} does not exist on Hedera mainnet` };
  if (token.type !== "NON_FUNGIBLE_UNIQUE") {
    return { error: `token ${tokenId} is not an NFT collection (type ${token.type})` };
  }

  // Ownership: the serial must currently sit in the caller's account.
  let serialBody: { account_id?: string } | null = null;
  try {
    const res = await fetchFn(
      `${MIRROR_API}/tokens/${encodeURIComponent(tokenId)}/nfts/${serial}`,
      { headers: { Accept: "application/json" } },
    );
    if (res.status === 404) return { error: `serial ${serial} of ${tokenId} does not exist` };
    if (!res.ok) throw new Error(`mirror node returned ${res.status}`);
    serialBody = (await res.json()) as { account_id?: string };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "mirror node unreachable — retry in a moment" };
  }
  if (serialBody?.account_id !== identity.accountId) {
    return {
      error: `serial ${serial} of ${tokenId} is held by ${serialBody?.account_id ?? "unknown"}, not your account ${identity.accountId} — only the holder can transfer it`,
    };
  }

  // Association guidance: an unassociated recipient makes the transfer
  // fail on-chain, so say so up front (the bytes are still returned —
  // association can happen any time before submission).
  let recipientAssociated: boolean | null = null;
  try {
    const res = await fetchFn(
      `${MIRROR_API}/accounts/${encodeURIComponent(recipient)}/tokens?token.id=${encodeURIComponent(tokenId)}`,
      { headers: { Accept: "application/json" } },
    );
    if (res.ok) {
      const body = (await res.json()) as { tokens?: unknown[] };
      recipientAssociated = Array.isArray(body.tokens) && body.tokens.length > 0;
    }
  } catch {
    recipientAssociated = null;
  }

  const tx = new TransferTransaction()
    .addNftTransfer(
      TokenId.fromString(tokenId),
      serial,
      AccountId.fromString(identity.accountId),
      AccountId.fromString(recipient),
    )
    // Ceiling only — an NFT transfer costs a fraction of a cent in HBAR.
    .setMaxTransactionFee(new Hbar(2))
    .setTransactionMemo(`Voicescape NFT gift: ${tokenId} #${serial}`.slice(0, 100));
  const prepared = freezeUnsigned(tx, identity.accountId);

  return {
    prepared: true,
    unsignedTxBytes: prepared.unsignedTxBytes,
    transactionId: prepared.transactionId,
    tokenId,
    serial,
    from: identity.accountId,
    to: recipient,
    recipientAssociated,
    instructions:
      `Sign the unsignedTxBytes with YOUR wallet key and submit — the server never sees your key. The transfer costs a fraction of a cent in HBAR, paid by you; no platform fee on gifts. ` +
      (recipientAssociated === false
        ? `WARNING: ${recipient} has NOT associated token ${tokenId} yet — the transfer will fail on-chain until they associate it (the dapp's NFT association helper builds their unsigned association transaction). Ask them to associate first, then submit. `
        : recipientAssociated === null
          ? `Note: could not confirm whether ${recipient} has associated ${tokenId} — if the transfer fails with TOKEN_NOT_ASSOCIATED, they need to associate first. `
          : `The recipient has associated ${tokenId}, so the transfer can land as soon as you submit. `) +
      `After it lands, the NFT is entirely theirs — hold, gift onward, or relist (a relist pays the lister 98%).`,
  };
}
