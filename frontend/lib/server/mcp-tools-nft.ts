/**
 * Voicescape MCP tools — Agent NFT Drops.
 *
 * Lets any registered blockpage owner (agent OR human) create their OWN
 * HTS NFT collection and mint NFTs for their OWN page. Three tools:
 *
 * - `prepare_nft_collection` — validates everything, then returns FROZEN
 *   UNSIGNED TokenCreateTransaction bytes (base64). The caller signs with
 *   their own Hedera key and submits. Treasury + supply + admin keys are
 *   the caller's own — the server never sees, holds, or signs with any key.
 * - `prepare_nft_mint` — pins the art to IPFS (or reuses a caller-pinned
 *   CID), builds + pins the wallet-readable (HIP-412) metadata JSON
 *   (name, description, image, creator, collection — the same document
 *   HashPack's NFT gallery reads, so art renders in both the dapp's
 *   gallery block and the owner's wallet), verifies the token is the
 *   caller's own NFT collection on the mirror node, then returns FROZEN
 *   UNSIGNED TokenMintTransaction bytes. The caller signs with their
 *   supply key and submits.
 * - `get_nft_collection` — read-only mirror-node view of a collection:
 *   token info + minted serials with decoded metadata.
 *
 * Invariants (Brandon's rules):
 * - Hedera-native only: @hiero-ledger/sdk TokenCreate/TokenMint +
 *   official mirror-node REST. No custom chain plumbing.
 * - Server never holds keys (RETURN_BYTES pattern, same as
 *   prepare_agent_self_claim / finalize_agent_self_claim).
 * - $0 platform operating cost: the minter pays ALL HTS network fees.
 *   The platform earns only via the existing 98/2 marketplace split on
 *   sales. No treasury subsidies, no platform-funded mints, no HTS
 *   creator-royalty fees on the token (resellers keep the lister's 98%).
 * - No platform-issued badges/points — user/agent-minted collectibles only.
 * - Copy never says "free": collection creation costs a few HBAR, each
 *   mint costs a fraction of a cent — the minter pays.
 *
 * Sales reuse the EXISTING marketplace flow untouched: the seller lists
 * with create_listing (goods_type "digital", token id + serial in the
 * description, art CID as ipfs_hash); the buyer pays through the Tips
 * contract's buyListing, which splits 98% to the SELLER NAMED ON THE
 * LISTING and 2% to the treasury (VoicescapeTips.sol buyListing —
 * verified 2026-10-08: the payout keys off the listing's seller, never the
 * original minter, so secondary relists pay the reseller). After payment
 * verifies, the seller transfers the NFT serial peer-to-peer from their
 * own wallet. No escrow; trust comes from the public on-chain record.
 */

import {
  AccountId,
  Client,
  Hbar,
  PublicKey,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TokenId,
  TokenMintTransaction,
  TokenSupplyType,
  TokenType,
  Transaction,
  TransactionId,
} from "@hiero-ledger/sdk";
import {
  lookupBlockpage,
  getRequestContext,
  USERNAME_RE,
  usernameValidationError,
} from "./mcp-tools";
import { defaultDeps, type TownhallDeps } from "./townhall/handlers";
import { requireNotRestricted } from "./townhall/bans";
import { checkContent } from "./townhall/content-filter";
import {
  globalQuotaStore,
  quotaLimitFromEnv,
  quotaExceededBody,
  type QuotaStore,
} from "./quota";
import { checkIpRateLimit } from "./rate-limit";
import { sniffMediaKind } from "./media-safety";
import { publishDigitalGood, MAX_DIGITAL_GOOD_BYTES } from "./publish.js";

export type NftFetchFn = typeof fetch;

/** Injectable seams — production passes nothing; tests inject fakes. */
export interface NftToolDeps {
  fetchFn?: NftFetchFn;
  townhallDeps?: TownhallDeps;
  quotaStore?: QuotaStore;
  /**
   * IPFS pin override (tests). Defaults to publishDigitalGood from
   * lib/server/publish.js — the same pin path the web upload route uses.
   */
  publishFn?: (
    data: Uint8Array,
    filename: string,
    mime: string,
  ) => Promise<{ cid: string }>;
}

const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com";
const MIRROR_API = `${MIRROR_BASE}/api/v1`;
const HASHSCAN_TOKEN = "https://hashscan.io/mainnet/token";
const IPFS_GATEWAY =
  process.env.NEXT_PUBLIC_IPFS_GATEWAY ?? "https://ipfs.io/ipfs/";

const TOKEN_ID_RE = /^0\.0\.\d+$/;
const ACCOUNT_ID_RE = /^\d+\.\d+\.\d+$/;
/** Collection names live on-chain permanently — keep them tight. */
const MAX_COLLECTION_NAME = 100;
const MAX_SYMBOL = 10;
const MAX_SUPPLY_CAP = 10_000;
const MAX_MEMO = 100;
/** HTS NFT metadata field limit is 100 bytes — an ipfs:// CID fits easily. */
const MAX_METADATA_BYTES = 100;
/** Wallet-readable NFT metadata standard (HIP-412) — HashPack's NFT gallery
 *  renders art from this JSON, so every mint pins it. */
const HIP412_FORMAT = "HIP412@2.0.0";
const MAX_NFT_NAME = 100;
const MAX_NFT_DESCRIPTION = 1000;

/* ------------------------------------------------------------------ */
/* Shared: identity + guards                                           */
/* ------------------------------------------------------------------ */

interface PageIdentity {
  username: string;
  /** Lowercase 0x owner address of the registered page. */
  wallet: string;
  /** 0.0.x owner account — the treasury for collections. */
  accountId: string;
}

/**
 * Resolve a claimed blockpage username to its on-chain owner. The page
 * must be registered; agent AND human pages are both welcome (NFT drops
 * are for any blockpage owner). The owner's account becomes the token
 * treasury — never anyone else's, so collections stay attributable.
 * Returns the identity or an error string.
 */
async function resolvePageOwner(
  rawUsername: unknown,
  fetchFn: NftFetchFn,
): Promise<PageIdentity | { error: string }> {
  const name = (rawUsername ?? "").toString().trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return { error: usernameValidationError(rawUsername) };
  const lookup = await lookupBlockpage(name, fetchFn);
  if (!lookup.found || !lookup.owner_evm) {
    return { error: `blockpage "${name}" is not registered on-chain — claim it first` };
  }
  if (!lookup.owner_account || !ACCOUNT_ID_RE.test(lookup.owner_account)) {
    return {
      error: `could not resolve the Hedera account behind "${name}" from the mirror node — retry in a moment`,
    };
  }
  return {
    username: name,
    wallet: lookup.owner_evm,
    accountId: lookup.owner_account,
  };
}

/** Per-IP rate-limit gate. Returns an error string when limited, null when OK. */
async function ipRateLimit(bucket: string, limit: number, windowMs: number): Promise<string | null> {
  const ip = getRequestContext().clientIp;
  try {
    const r = await checkIpRateLimit(ip, bucket, limit, windowMs);
    if (!r.allowed) return "too many requests from this network — try again later";
  } catch (e) {
    console.error(`[mcp-nft] ip rate-limit store unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return "temporarily unavailable — please retry in a moment";
  }
  return null;
}

/** Restriction gate: banned/timed-out/copyright-suspended wallets cannot write. */
async function restrictionError(deps: TownhallDeps, wallet: string): Promise<string | null> {
  try {
    const blocked = await requireNotRestricted(deps, wallet);
    if (blocked) {
      const body = blocked.json as { error?: string };
      return typeof body?.error === "string" ? body.error : "this wallet is restricted from posting";
    }
  } catch (e) {
    console.error(`[mcp-nft] restriction check failed: ${e instanceof Error ? e.message : String(e)}`);
    return "temporarily unavailable — please retry in a moment";
  }
  return null;
}

/** Per-wallet daily prepare quota (off-chain prepares are cheap but not free to abuse). */
async function prepareQuota(
  quotaStore: QuotaStore,
  wallet: string,
): Promise<string | null> {
  const limit = quotaLimitFromEnv("NFT_PREPARE_DAILY_QUOTA", 10);
  let q;
  try {
    q = await quotaStore.consume("nft:prepare", wallet, limit);
  } catch (e) {
    console.error(`[mcp-nft] prepare quota store unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return "temporarily unavailable — please retry in a moment";
  }
  if (!q.allowed) {
    return quotaExceededBody(q, `daily NFT prepare limit reached (${limit}/day)`).error as string;
  }
  return null;
}

/**
 * Freeze an SDK transaction into base64 unsigned bytes. Never signs —
 * freezeWith only finalizes the body for the caller's own key.
 */
function freezeUnsigned(
  tx: Transaction,
  payerAccountId: string,
): { unsignedTxBytes: string; transactionId: string } {
  const payer = AccountId.fromString(payerAccountId);
  const txId = TransactionId.generate(payer);
  tx.setTransactionId(txId);
  const client = Client.forMainnet();
  tx.freezeWith(client);
  const bytes = tx.toBytes();
  return {
    unsignedTxBytes: Buffer.from(bytes).toString("base64"),
    transactionId: txId.toString(),
  };
}

/** Plausible IPFS CID (v0 Qm… or v1 baf…) — shape check, mirrors createListing. */
function isPlausibleCid(s: string): boolean {
  return (
    s.length <= 128 &&
    (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(s) || /^baf[a-z0-9]{50,120}$/.test(s))
  );
}

interface MirrorToken {
  token_id: string;
  name: string;
  symbol: string;
  type: string;
  treasury_account_id: string | null;
  max_supply: string | null;
  total_supply: string | null;
}

/** Fetch token info from the mirror node. Throws on transport errors. */
async function fetchMirrorToken(tokenId: string, fetchFn: NftFetchFn): Promise<MirrorToken | null> {
  let res: Response;
  try {
    res = await fetchFn(`${MIRROR_API}/tokens/${tokenId}`);
  } catch (e) {
    throw new Error(`mirror node unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`mirror node error (${res.status}) reading token ${tokenId}`);
  return (await res.json()) as MirrorToken;
}

/* ------------------------------------------------------------------ */
/* prepare_nft_collection                                                */
/* ------------------------------------------------------------------ */

export interface PrepareNftCollectionArgs {
  /** Your registered blockpage username (agent or human page). */
  agent_username: string;
  /** Collection name, 3–100 chars — permanent on-chain. */
  name: string;
  /** Ticker, 1–10 uppercase letters/digits — permanent on-chain. */
  symbol: string;
  /** Max NFTs ever mintable, 1–10000. */
  max_supply: number;
  /**
   * YOUR Hedera PUBLIC key (ED25519 64-hex or ECDSA compressed 66-hex)
   * — becomes the supply key AND admin key. The matching private key
   * must also control the treasury account below, so one signature
   * executes the create. The server never sees your private key.
   */
  supply_public_key: string;
  /** Optional memo, ≤100 chars. */
  memo?: string;
}

export interface PreparedNftCollection {
  prepared: true;
  /** Base64 frozen UNSIGNED TokenCreateTransaction bytes — you sign these. */
  unsignedTxBytes: string;
  /** The tx's own id, "0.0.x@seconds.nanos" — for mirror confirmation. */
  transactionId: string;
  treasury: string;
  name: string;
  symbol: string;
  maxSupply: number;
  hashscanUrl: string;
  instructions: string;
}

export async function prepareNftCollection(
  args: PrepareNftCollectionArgs,
  injected: NftToolDeps = {},
): Promise<PreparedNftCollection | { error: string }> {
  const fetchFn = injected.fetchFn ?? fetch;
  const deps = injected.townhallDeps ?? defaultDeps();
  const quotaStore = injected.quotaStore ?? globalQuotaStore();

  if (!args || typeof args !== "object") return { error: "arguments are required" };

  const limited = await ipRateLimit("mcp-nft", 30, 60_000);
  if (limited) return { error: limited };

  const identity = await resolvePageOwner(args?.agent_username, fetchFn);
  if ("error" in identity) return identity;

  const restricted = await restrictionError(deps, identity.wallet);
  if (restricted) return { error: restricted };

  const qErr = await prepareQuota(quotaStore, identity.wallet);
  if (qErr) return { error: qErr };

  const name = (args.name ?? "").toString().trim();
  if (name.length < 3 || name.length > MAX_COLLECTION_NAME) {
    return { error: `name must be 3–${MAX_COLLECTION_NAME} characters` };
  }
  const symbol = (args.symbol ?? "").toString().trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) {
    return { error: "symbol must be 1–10 uppercase letters/digits" };
  }
  const maxSupply = args.max_supply;
  if (!Number.isInteger(maxSupply) || maxSupply < 1 || maxSupply > MAX_SUPPLY_CAP) {
    return { error: `max_supply must be an integer 1–${MAX_SUPPLY_CAP}` };
  }
  const memo = args.memo === undefined || args.memo === null ? "" : args.memo.toString().trim();
  if (memo.length > MAX_MEMO) return { error: `memo must be ≤${MAX_MEMO} characters` };

  // On-chain-permanent text goes through the same safety gate as listings.
  for (const [label, text] of [["collection name", name], ["collection symbol", symbol], ["collection memo", memo]] as const) {
    if (!text) continue;
    const gate = checkContent(text, label);
    if (!gate.allowed) return { error: gate.reason ?? `${label} blocked by safety filter` };
  }

  let supplyKey: PublicKey;
  try {
    supplyKey = PublicKey.fromString((args.supply_public_key ?? "").toString().trim());
  } catch {
    return {
      error:
        "supply_public_key is not a parseable Hedera public key — pass ED25519 (64 hex chars) or ECDSA compressed (66 hex chars, 02/03 prefix). This becomes the supply AND admin key; its private key must also control your treasury account so one signature executes the create.",
    };
  }

  const treasury = identity.accountId;
  const tx = new TokenCreateTransaction()
    .setTokenName(name)
    .setTokenSymbol(symbol)
    .setTokenType(TokenType.NonFungibleUnique)
    .setDecimals(0)
    .setInitialSupply(0)
    .setTreasuryAccountId(AccountId.fromString(treasury))
    .setSupplyType(TokenSupplyType.Finite)
    .setMaxSupply(maxSupply)
    .setSupplyKey(supplyKey)
    .setAdminKey(supplyKey)
    .setTokenMemo(memo)
    // Ceiling only — you pay the actual network fee, a few HBAR.
    .setMaxTransactionFee(new Hbar(30))
    .setTransactionMemo(`Voicescape NFT collection: ${name}`.slice(0, 100));

  const { unsignedTxBytes, transactionId } = freezeUnsigned(tx, treasury);

  return {
    prepared: true,
    unsignedTxBytes,
    transactionId,
    treasury,
    name,
    symbol,
    maxSupply,
    // "0.0.123@1700000000.000000001" → HashScan form "0.0.123-1700000000-000000001".
    hashscanUrl: `https://hashscan.io/mainnet/transaction/${transactionId.replace(/^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/, "$1-$2-$3")}`,
    instructions:
      `Sign the unsignedTxBytes with YOUR OWN Hedera key — the one matching supply_public_key, which must also be a key on the treasury account ${treasury} — and submit. The server never sees your key. ` +
      `Cost honesty: creating the collection costs a few HBAR in network fees, paid by you; the platform pays nothing and takes no cut at mint. ` +
      `Read the new token id (0.0.x) from the transaction receipt, then mint with prepare_nft_mint, then show the drop on your page with an NFT Gallery block (block type "nftGallery", your token_id). ` +
      `To sell: list with create_listing (goods_type "digital", token id + serial in the description, art CID as ipfs_hash) — buyers pay through the Tips contract, 98% to your wallet and 2% to the treasury, atomic on-chain.`,
  };
}

/* ------------------------------------------------------------------ */
/* prepare_nft_mint                                                      */
/* ------------------------------------------------------------------ */

export interface PrepareNftMintArgs {
  /** Your registered blockpage username (agent or human page). */
  agent_username: string;
  /** Your HTS NFT collection, 0.0.x — must be treasury-held by your page's account. */
  token_id: string;
  /** Display name for this NFT, 1–100 chars — goes in the wallet-readable metadata JSON. */
  name: string;
  /** Optional description, ≤1000 chars — goes in the metadata JSON. */
  description?: string;
  /** Already-pinned IPFS CID of the artwork (Qm… or baf…). Preferred: pin it yourself, $0 platform cost. */
  image_cid?: string;
  /** ALTERNATIVE to image_cid: base64 artwork bytes (image only, ≤10 MB) — pinned via the platform pin quota. */
  image_base64?: string;
  /** Original filename for the pinned art (extension only is kept). */
  filename?: string;
  /**
   * MIME of already-pinned art (image_cid path only): image/jpeg,
   * image/png, image/gif, or image/webp. Defaults to image/png.
   */
  image_mime?: string;
}

export interface PreparedNftMint {
  prepared: true;
  /** Base64 frozen UNSIGNED TokenMintTransaction bytes — sign with your supply key. */
  unsignedTxBytes: string;
  /** The tx's own id, "0.0.x@seconds.nanos" — for mirror confirmation. */
  transactionId: string;
  tokenId: string;
  /** The on-chain metadata bytes: ipfs://<cid> of the HIP-412 JSON below. */
  metadata: string;
  /** CID of the pinned artwork image. */
  artCid: string;
  /** CID of the pinned HIP-412 metadata JSON (what wallets read). */
  metadataCid: string;
  /** The exact wallet-readable metadata JSON that was pinned. */
  metadataJson: Record<string, unknown>;
  instructions: string;
}

/**
 * Build the wallet-readable (HIP-412-style) metadata JSON for a mint.
 * HashPack's NFT gallery renders art from THIS document: it reads the
 * on-chain metadata URI, fetches this JSON, and displays `image`.
 */
export function buildHip412Metadata(input: {
  name: string;
  description: string;
  imageCid: string;
  mime: string;
  creator: string;
  collectionName: string;
  tokenId: string;
  serialHint?: string;
}): Record<string, unknown> {
  return {
    name: input.name,
    creator: input.creator,
    description: input.description,
    image: `ipfs://${input.imageCid}`,
    type: input.mime,
    format: HIP412_FORMAT,
    properties: {
      collection: input.collectionName,
      token_id: input.tokenId,
      artist: input.creator,
    },
  };
}

/**
 * Validate a metadata JSON against the wallet-readable schema:
 * name, creator, description, image (ipfs:// + plausible CID), type,
 * format. Returns an error list — empty means valid.
 */
export function validateHip412Metadata(obj: unknown): string[] {
  const errors: string[] = [];
  if (typeof obj !== "object" || obj === null) return ["metadata is not a JSON object"];
  const o = obj as Record<string, unknown>;
  for (const f of ["name", "creator", "description", "image", "type", "format"] as const) {
    if (typeof o[f] !== "string" || !(o[f] as string).trim()) {
      errors.push(`missing or empty required field "${f}"`);
    }
  }
  const image = (o.image as string) ?? "";
  const m = /^ipfs:\/\/([A-Za-z0-9]+)$/.exec(image.trim());
  if (!m) {
    errors.push('image must be an ipfs:// URI (e.g. "ipfs://Qm…")');
  } else if (!isPlausibleCid(m[1])) {
    errors.push("image CID is not a plausible IPFS CID");
  }
  if (o.format !== HIP412_FORMAT) {
    errors.push(`format must be "${HIP412_FORMAT}"`);
  }
  return errors;
}

export interface ResolvedNftMedia {
  /** https artwork URL, or null when the metadata can't be resolved. */
  imageUrl: string | null;
  /** Display name from the metadata JSON, or null. */
  name: string | null;
}

/**
 * Resolve an on-chain NFT metadata URI (ipfs://<cid> of the HIP-412 JSON)
 * to its artwork URL + display name. Best-effort: returns nulls (never
 * throws) when the gateway can't answer, so galleries degrade honestly.
 */
export async function resolveNftMedia(
  metadataUri: string,
  fetchFn: NftFetchFn = fetch,
): Promise<ResolvedNftMedia> {
  const none: ResolvedNftMedia = { imageUrl: null, name: null };
  const m = /^ipfs:\/\/([A-Za-z0-9]+)$/.exec((metadataUri ?? "").trim());
  if (!m || !isPlausibleCid(m[1])) return none;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchFn(`${IPFS_GATEWAY}${m[1]}`, { signal: ctrl.signal } as RequestInit);
    if (!res.ok) return none;
    const json = (await res.json()) as Record<string, unknown>;
    if (validateHip412Metadata(json).length > 0) return none;
    const image = (json.image as string).replace(/^ipfs:\/\/([A-Za-z0-9]+)$/, `${IPFS_GATEWAY}$1`);
    return {
      imageUrl: image,
      name: typeof json.name === "string" ? json.name : null,
    };
  } catch {
    return none;
  } finally {
    clearTimeout(timer);
  }
}

const NFT_ART_MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

function safeArtFilename(raw: unknown, ext: string): string {
  void raw;
  return `nft-art-${Date.now()}.${ext}`;
}

export async function prepareNftMint(
  args: PrepareNftMintArgs,
  injected: NftToolDeps = {},
): Promise<PreparedNftMint | { error: string }> {
  const fetchFn = injected.fetchFn ?? fetch;
  const deps = injected.townhallDeps ?? defaultDeps();
  const quotaStore = injected.quotaStore ?? globalQuotaStore();
  const publishFn = injected.publishFn ?? publishDigitalGood;

  if (!args || typeof args !== "object") return { error: "arguments are required" };

  const limited = await ipRateLimit("mcp-nft", 30, 60_000);
  if (limited) return { error: limited };

  const identity = await resolvePageOwner(args?.agent_username, fetchFn);
  if ("error" in identity) return identity;

  const restricted = await restrictionError(deps, identity.wallet);
  if (restricted) return { error: restricted };

  const qErr = await prepareQuota(quotaStore, identity.wallet);
  if (qErr) return { error: qErr };

  const tokenId = (args.token_id ?? "").toString().trim();
  if (!TOKEN_ID_RE.test(tokenId)) {
    return { error: "token_id must look like 0.0.123456" };
  }

  // The token must be YOUR NFT collection: right type, your treasury.
  // Fail closed when the mirror node can't answer — minting into the
  // wrong token would waste your HBAR.
  let token: MirrorToken | null;
  try {
    token = await fetchMirrorToken(tokenId, fetchFn);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "mirror node unreachable — retry in a moment" };
  }
  if (!token) return { error: `token ${tokenId} does not exist on Hedera mainnet` };
  if (token.type !== "NON_FUNGIBLE_UNIQUE") {
    return { error: `token ${tokenId} is not an NFT collection (type ${token.type})` };
  }
  if (token.treasury_account_id !== identity.accountId) {
    return {
      error: `token ${tokenId} is not yours — its treasury is ${token.treasury_account_id ?? "unknown"}, your page's account is ${identity.accountId}. Only the collection owner can mint.`,
    };
  }

  const nftName = (args.name ?? "").toString().trim();
  if (nftName.length < 1 || nftName.length > MAX_NFT_NAME) {
    return { error: `name must be 1–${MAX_NFT_NAME} characters` };
  }
  const rawDescription = (args.description ?? "").toString().trim();
  if (rawDescription.length > MAX_NFT_DESCRIPTION) {
    return { error: `description must be ≤${MAX_NFT_DESCRIPTION} characters` };
  }
  // Wallets expect a description in the metadata JSON — default it so the
  // schema always validates even when the minter skips it.
  const nftDescription =
    rawDescription || `${nftName} — an NFT from ${identity.username}'s collection on Voicescape`;
  for (const [label, text] of [["NFT name", nftName], ["NFT description", nftDescription]] as const) {
    if (!text) continue;
    const gate = checkContent(text, label);
    if (!gate.allowed) return { error: gate.reason ?? `${label} blocked by safety filter` };
  }

  // --- Artwork: caller-pinned CID preferred ($0 platform cost); else pin it. ---
  // The art pin shares one quota bucket with the metadata-JSON pin below.
  const plimit = quotaLimitFromEnv("NFT_ART_DAILY_QUOTA", 10);
  let artCid: string;
  let artMime = "image/png";
  const givenCid = (args.image_cid ?? "").toString().trim();
  if (givenCid) {
    if (!isPlausibleCid(givenCid)) return { error: "image_cid must be a valid IPFS CID (Qm… or baf…)" };
    artCid = givenCid;
    const hinted = (args.image_mime ?? "").toString().trim().toLowerCase();
    if (hinted) {
      if (!Object.values(NFT_ART_MIME).includes(hinted)) {
        return { error: "image_mime must be image/jpeg, image/png, image/gif, or image/webp" };
      }
      artMime = hinted;
    }
  } else {
    if (typeof args.image_base64 !== "string" || !args.image_base64.trim()) {
      return { error: "pass image_cid (already pinned) or image_base64 (to pin now)" };
    }
    let pq;
    try {
      pq = await quotaStore.consume("pin:nft-art", identity.wallet, plimit);
    } catch (e) {
      console.error(`[mcp-nft] art quota store unreachable: ${e instanceof Error ? e.message : String(e)}`);
      return { error: "temporarily unavailable — please retry in a moment" };
    }
    if (!pq.allowed) {
      return { error: quotaExceededBody(pq, `daily NFT art pin limit reached (${plimit}/day)`).error as string };
    }
    const b64text = args.image_base64.trim().replace(/\s+/g, "");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(b64text, "base64"));
    } catch {
      return { error: "image_base64 is not valid base64" };
    }
    // Buffer.from never throws on bad base64 — re-encode and compare.
    const recoded = Buffer.from(bytes).toString("base64").replace(/=+$/, "");
    if (recoded !== b64text.replace(/=+$/, "")) return { error: "image_base64 is not valid base64" };
    if (bytes.length === 0) return { error: "empty file" };
    if (bytes.length > MAX_DIGITAL_GOOD_BYTES) {
      return { error: `file too large (max ${MAX_DIGITAL_GOOD_BYTES / 1024 / 1024} MB)` };
    }
    const sniffed = sniffMediaKind(bytes);
    const mime = NFT_ART_MIME[sniffed];
    if (!mime) {
      return { error: "NFT art must be an image (JPEG, PNG, GIF, or WebP)" };
    }
    artMime = mime;
    const ext = sniffed === "jpeg" ? "jpg" : sniffed;
    try {
      const pinned = await publishFn(bytes, safeArtFilename(args.filename, ext), mime);
      artCid = pinned.cid;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "PINATA_UNAVAILABLE") return { error: "file pinning is temporarily unavailable" };
      console.error(`[mcp-nft] pin failed: ${msg}`);
      return { error: "file upload failed — try again in a moment" };
    }
    if (!isPlausibleCid(artCid)) {
      console.error(`[mcp-nft] pin returned implausible CID: ${artCid}`);
      return { error: "file upload failed — try again in a moment" };
    }
  }

  // --- Wallet-readable metadata (HIP-412): pin the JSON, mint its CID. ---
  // HashPack's NFT gallery renders art from THIS document, so the metadata
  // field points at the JSON — never at the raw image.
  const metadataJson = buildHip412Metadata({
    name: nftName,
    description: nftDescription,
    imageCid: artCid,
    mime: artMime,
    creator: identity.username,
    collectionName: token.name,
    tokenId,
  });
  const schemaErrors = validateHip412Metadata(metadataJson);
  if (schemaErrors.length > 0) {
    // Should never happen — the builder above is fixed-shape. Fail closed
    // rather than minting metadata wallets can't render.
    console.error(`[mcp-nft] built invalid HIP-412 metadata: ${schemaErrors.join("; ")}`);
    return { error: "could not build valid NFT metadata — try again in a moment" };
  }
  let mq;
  try {
    mq = await quotaStore.consume("pin:nft-art", identity.wallet, plimit);
  } catch (e) {
    console.error(`[mcp-nft] metadata quota store unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return { error: "temporarily unavailable — please retry in a moment" };
  }
  if (!mq.allowed) {
    return { error: quotaExceededBody(mq, `daily NFT art pin limit reached (${plimit}/day)`).error as string };
  }
  let metadataCid: string;
  try {
    const pinned = await publishFn(
      new Uint8Array(Buffer.from(JSON.stringify(metadataJson), "utf8")),
      `nft-metadata-${Date.now()}.json`,
      "application/json",
    );
    metadataCid = pinned.cid;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "PINATA_UNAVAILABLE") return { error: "metadata pinning is temporarily unavailable" };
    console.error(`[mcp-nft] metadata pin failed: ${msg}`);
    return { error: "metadata upload failed — try again in a moment" };
  }
  if (!isPlausibleCid(metadataCid)) {
    console.error(`[mcp-nft] metadata pin returned implausible CID: ${metadataCid}`);
    return { error: "metadata upload failed — try again in a moment" };
  }

  const metadata = `ipfs://${metadataCid}`;
  if (Buffer.byteLength(metadata, "utf8") > MAX_METADATA_BYTES) {
    return { error: "metadata URI too long for the 100-byte HTS metadata field" };
  }

  const tx = new TokenMintTransaction()
    .setTokenId(TokenId.fromString(tokenId))
    .setMetadata([Buffer.from(metadata, "utf8")])
    // Ceiling only — an NFT mint costs a fraction of a cent in HBAR.
    .setMaxTransactionFee(new Hbar(5))
    .setTransactionMemo(`Voicescape NFT mint: ${tokenId}`.slice(0, 100));

  const { unsignedTxBytes, transactionId } = freezeUnsigned(tx, identity.accountId);

  return {
    prepared: true,
    unsignedTxBytes,
    transactionId,
    tokenId,
    metadata,
    artCid,
    metadataCid,
    metadataJson,
    instructions:
      `Sign the unsignedTxBytes with YOUR supply key and submit — the server never sees your key. ` +
      `Cost honesty: each mint costs a fraction of a cent in HBAR, paid by you; the platform pays nothing and takes no cut at mint. ` +
      `The on-chain metadata is an ipfs:// URI to a wallet-readable (HIP-412) JSON document, so the NFT renders its art in both the dapp's NFT Gallery block and the owner's HashPack NFT gallery. ` +
      `The new serial appears in your NFT Gallery block automatically (it reads the mirror node live). ` +
      `To sell: list with create_listing (goods_type "digital") — put "HTS NFT ${tokenId}" and the serial in the description and the art CID as ipfs_hash. ` +
      `Buyers pay through the Tips contract: 98% to YOUR wallet, 2% to the treasury, atomic on-chain, no escrow. ` +
      `After the purchase verifies, transfer the NFT serial to the buyer from your own wallet (HashPack does peer-to-peer NFT transfers). The dapp never custodies the NFT. ` +
      `True ownership: the buyer can hold it, view it in HashPack's NFT gallery, send it to anyone, or relist it — a relist pays the lister (them) 98%.`,
  };
}

/* ------------------------------------------------------------------ */
/* get_nft_collection (read-only)                                        */
/* ------------------------------------------------------------------ */

export interface NftCollectionNft {
  serial: number;
  /** On-chain metadata URI (ipfs://<cid> of the HIP-412 JSON). */
  metadata: string;
  /** Display name from the metadata JSON, when resolvable. */
  name: string | null;
  imageUrl: string | null;
  hashscanUrl: string;
}

export interface NftCollectionInfo {
  tokenId: string;
  name: string;
  symbol: string;
  treasury: string | null;
  maxSupply: string | null;
  totalSupply: string | null;
  hashscanUrl: string;
  nfts: NftCollectionNft[];
  note: string;
}

/** Decode mirror-node base64 NFT metadata to a UTF-8 string (best effort). */
export function decodeNftMetadata(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/* (image resolution now goes through resolveNftMedia above, which fetches
 * the wallet-readable metadata JSON — pointing metadata at the raw image
 * would render nothing in HashPack's gallery.) */

export async function getNftCollection(
  args: { token_id: string },
  injected: NftToolDeps = {},
): Promise<NftCollectionInfo | { error: string }> {
  const fetchFn = injected.fetchFn ?? fetch;
  if (!args || typeof args !== "object") return { error: "arguments are required" };

  const limited = await ipRateLimit("mcp-nft", 60, 60_000);
  if (limited) return { error: limited };

  const tokenId = (args.token_id ?? "").toString().trim();
  if (!TOKEN_ID_RE.test(tokenId)) {
    return { error: "token_id must look like 0.0.123456" };
  }

  let token: MirrorToken | null;
  try {
    token = await fetchMirrorToken(tokenId, fetchFn);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "mirror node unreachable — retry in a moment" };
  }
  if (!token) return { error: `token ${tokenId} does not exist on Hedera mainnet` };

  let serials: Array<{ serial_number: number; metadata: string }> = [];
  try {
    const res = await fetchFn(`${MIRROR_API}/tokens/${tokenId}/nfts?limit=100&order=desc`);
    if (res.ok) {
      const body = (await res.json()) as {
        nfts?: Array<{ serial_number: number; metadata?: string }>;
      };
      serials = (body.nfts ?? []).map((n) => ({
        serial_number: n.serial_number,
        metadata: decodeNftMetadata(n.metadata),
      }));
    }
  } catch {
    // Token info is the core answer; serials are best-effort.
    serials = [];
  }

  // Resolve each distinct metadata document once — the wallet-readable
  // JSON carries the display name + artwork URL.
  const mediaCache = new Map<string, ResolvedNftMedia>();
  async function mediaFor(uri: string): Promise<ResolvedNftMedia> {
    let m = mediaCache.get(uri);
    if (!m) {
      m = await resolveNftMedia(uri, fetchFn);
      mediaCache.set(uri, m);
    }
    return m;
  }

  const nfts: NftCollectionNft[] = [];
  for (const s of serials) {
    const media = await mediaFor(s.metadata);
    nfts.push({
      serial: s.serial_number,
      metadata: s.metadata,
      name: media.name,
      imageUrl: media.imageUrl,
      hashscanUrl: `${HASHSCAN_TOKEN}/${tokenId}`,
    });
  }

  return {
    tokenId,
    name: token.name,
    symbol: token.symbol,
    treasury: token.treasury_account_id,
    maxSupply: token.max_supply,
    totalSupply: token.total_supply,
    hashscanUrl: `${HASHSCAN_TOKEN}/${tokenId}`,
    nfts,
    note:
      serials.length === 0
        ? "No NFTs minted in this collection yet."
        : "Newest serials first (max 100). Artwork resolves from each NFT's wallet-readable metadata JSON; unresolvable art shows the serial with its HashScan link instead. Every NFT links to its HashScan token page for independent verification.",
  };
}

/* ------------------------------------------------------------------ */
/* Buyer-side: prepare an unsigned token-association transaction.        */
/*                                                                     */
/* Hedera requires an account to associate an HTS token before it can   */
/* receive the NFT. This builds the FROZEN UNSIGNED                    */
/* TokenAssociateTransaction for the BUYER's own account — the buyer    */
/* signs in their own wallet (via the existing submitPreparedTx        */
/* pipeline, untouched) and pays the tiny association fee. The server   */
/* never signs, never holds keys.                                      */
/* ------------------------------------------------------------------ */

export interface PreparedNftAssociation {
  prepared: true;
  unsignedTxBytes: string;
  transactionId: string;
  accountId: string;
  tokenId: string;
  alreadyAssociated?: boolean;
}

export async function prepareNftAssociation(
  args: { account_id: string; token_id: string },
  injected: NftToolDeps = {},
): Promise<PreparedNftAssociation | { error: string }> {
  const fetchFn = injected.fetchFn ?? fetch;
  if (!args || typeof args !== "object") return { error: "arguments are required" };

  const limited = await ipRateLimit("mcp-nft", 30, 60_000);
  if (limited) return { error: limited };

  const accountId = (args.account_id ?? "").toString().trim();
  if (!ACCOUNT_ID_RE.test(accountId)) {
    return { error: "account_id must look like 0.0.123456 (your own Hedera account)" };
  }
  const tokenId = (args.token_id ?? "").toString().trim();
  if (!TOKEN_ID_RE.test(tokenId)) {
    return { error: "token_id must look like 0.0.123456" };
  }

  // Token must exist and be an NFT collection — fail closed otherwise.
  let token: MirrorToken | null;
  try {
    token = await fetchMirrorToken(tokenId, fetchFn);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "mirror node unreachable — retry in a moment" };
  }
  if (!token) return { error: `token ${tokenId} does not exist on Hedera mainnet` };
  if (token.type !== "NON_FUNGIBLE_UNIQUE") {
    return { error: `token ${tokenId} is not an NFT collection` };
  }

  // Skip the signature round-trip when the account is already associated.
  try {
    const rel = await fetchFn(
      `${MIRROR_API}/accounts/${accountId}/tokens?token.id=${tokenId}&limit=1`,
    );
    if (rel.ok) {
      const body = (await rel.json()) as { tokens?: Array<{ token_id?: string }> };
      if ((body.tokens ?? []).some((t) => t.token_id === tokenId)) {
        return {
          prepared: true,
          unsignedTxBytes: "",
          transactionId: "",
          accountId,
          tokenId,
          alreadyAssociated: true,
        };
      }
    }
  } catch {
    // Best-effort check — proceed to build the tx when it can't answer.
  }

  const tx = new TokenAssociateTransaction()
    .setAccountId(AccountId.fromString(accountId))
    .setTokenIds([TokenId.fromString(tokenId)])
    .setMaxTransactionFee(new Hbar(2))
    .setTransactionMemo(`Voicescape: associate ${tokenId}`.slice(0, 100));

  const { unsignedTxBytes, transactionId } = freezeUnsigned(tx, accountId);
  return { prepared: true, unsignedTxBytes, transactionId, accountId, tokenId };
}
