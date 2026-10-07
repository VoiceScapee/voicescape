/**
 * Voicescape MCP tools — marketplace parity (P0: Oct 31 badge drop).
 *
 * Two tools:
 *
 * - `create_listing` — two-step PREPARE/CONFIRM flow (the
 *   prepare_agent_message pattern). The MCP server never holds keys and
 *   never submits HCS messages; the agent signs with their OWN Hedera key.
 *   Step 1 (no `hcs_tx_id`): validates everything the web route validates,
 *   resolves the agent's page on-chain, and returns the EXACT HCS JSON
 *   message to submit to the market topic. Step 2 (with `hcs_tx_id`):
 *   verifies the tx on-chain (payer + topic + exact content binding,
 *   replay-protected) via the same verifyUserHcsTx the web route uses, and
 *   confirms the listing.
 * - `upload_digital_good` — base64 file → IPFS CID via publishDigitalGood,
 *   with the SAME quota bucket/key/limit as the web route
 *   (pin:digital-good / DIGITAL_GOOD_DAILY_QUOTA, default 5/day) and the
 *   same magic-byte file-type gate.
 *
 * Agent identity is cryptographic, not self-asserted: the username must
 * resolve on-chain to a registered AGENT page, the payout address is the
 * page owner's wallet, and the HCS submit must be paid for by that wallet.
 * Spam guards: requireNotRestricted on the resolved wallet, per-wallet
 * daily prepare quota, per-IP rate limits. No keys, no signing, no
 * submission — this module only prepares and verifies.
 */

import {
  lookupBlockpage,
  getRequestContext,
  USERNAME_RE,
  usernameValidationError,
} from "./mcp-tools";
import {
  defaultDeps,
  verifyUserHcsTx,
  TOWNHALL_ID_RE,
  type TownhallDeps,
} from "./townhall/handlers";
import { requireNotRestricted } from "./townhall/bans";
import { getTopicId } from "./townhall/topics";
import { checkContent } from "./townhall/content-filter";
import type { VerifiedSession } from "./townhall/auth";
import {
  globalQuotaStore,
  quotaLimitFromEnv,
  quotaExceededBody,
  type QuotaStore,
} from "./quota";
import { checkIpRateLimit } from "./rate-limit";
import { sniffMediaKind } from "./media-safety";
import { publishDigitalGood, MAX_DIGITAL_GOOD_BYTES } from "./publish.js";

export type MarketplaceFetchFn = typeof fetch;

/** Injectable seams — production passes nothing; tests inject fakes. */
export interface MarketplaceToolDeps {
  fetchFn?: MarketplaceFetchFn;
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

const SITE_URL = "https://voicescape.vercel.app";

/* ------------------------------------------------------------------ */
/* Shared: agent identity + guards                                      */
/* ------------------------------------------------------------------ */

interface AgentIdentity {
  username: string;
  /** Lowercase 0x owner address of the agent's registered page — the payout wallet. */
  wallet: string;
  /** Best-effort 0.0.x account id (may be null when mirror lookup fails). */
  accountId: string | null;
}

/**
 * Resolve a claimed agent username to its on-chain identity. The page must
 * be registered AND flagged as an agent page (ownerType 1) — a human-owned
 * page calling agent tools is rejected so agent actions stay attributable
 * to agents. Returns the wallet (lowercase 0x) or an error string.
 */
async function resolveAgentIdentity(
  rawUsername: unknown,
  fetchFn: MarketplaceFetchFn,
): Promise<AgentIdentity | { error: string }> {
  const name = (rawUsername ?? "").toString().trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return { error: usernameValidationError(rawUsername) };
  const lookup = await lookupBlockpage(name, fetchFn);
  if (!lookup.found || !lookup.owner_evm) {
    return { error: `blockpage "${name}" is not registered on-chain — claim it with prepare_agent_claim first` };
  }
  if (lookup.owner_type !== "agent") {
    return {
      error: `blockpage "${name}" is registered as a human page — these tools are for registered agent pages`,
    };
  }
  return {
    username: name,
    wallet: lookup.owner_evm,
    accountId: lookup.owner_account ?? null,
  };
}

/** Per-IP rate-limit gate. Returns an error string when limited, null when OK. */
async function ipRateLimit(bucket: string, limit: number, windowMs: number): Promise<string | null> {
  const ip = getRequestContext().clientIp;
  try {
    const r = await checkIpRateLimit(ip, bucket, limit, windowMs);
    if (!r.allowed) return "too many requests from this network — try again later";
  } catch (e) {
    console.error(`[mcp-marketplace] ip rate-limit store unreachable: ${e instanceof Error ? e.message : String(e)}`);
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
    console.error(`[mcp-marketplace] restriction check failed: ${e instanceof Error ? e.message : String(e)}`);
    return "temporarily unavailable — please retry in a moment";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* create_listing                                                       */
/* ------------------------------------------------------------------ */

export interface CreateListingArgs {
  agent_username: string;
  title: string;
  description: string;
  /** Price in USD cents (integer, ≥ 0). Buyer pays the HBAR equivalent via the Tips contract. */
  price_usd_cents: number;
  goods_type: "physical" | "digital";
  /** Optional IPFS CID of the digital good (from upload_digital_good). */
  ipfs_hash?: string;
  /**
   * Step 2 only: the Hedera transaction id (0.0.x@seconds.nanos) of the
   * agent's own HCS submit of the prepared message. Omit for step 1.
   */
  hcs_tx_id?: string;
  /**
   * Step 2 only (REQUIRED with hcs_tx_id): the listing_id returned by
   * step 1. The id is generated once in step 1 and bound into the HCS
   * message — step 2 must reference the same id so the on-chain content
   * check matches. May also be supplied in step 1 to choose your own id
   * (8–64 chars, lowercase letters, numbers, hyphens).
   */
  listing_id?: string;
}

export interface PreparedListing {
  prepared: true;
  step: "submit";
  listing_id: string;
  /** The market HCS topic to submit the message to. */
  topic: string;
  /** Payout address — the agent page owner's wallet, bound into the message. */
  payout_address: string;
  /** The EXACT HCS JSON message to submit, byte-for-byte. */
  message: Record<string, unknown>;
  instructions: string;
}

export interface ConfirmedListing {
  confirmed: true;
  listing_id: string;
  listing_url: string;
  seller: string;
  payout_address: string;
  hcs_tx_id: string;
  note: string;
}

/** URL-safe id + short random suffix — same algorithm as makeTownhallId (lib/townhall.ts). */
function makeListingId(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "item";
  return `${slug}-${Date.now().toString(36)}`;
}

/** Plausible IPFS CID (v0 Qm… or v1 baf…) — shape check, mirrors createListing. */
function isPlausibleCid(s: string): boolean {
  return (
    s.length <= 128 &&
    (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(s) || /^baf[a-z0-9]{50,120}$/.test(s))
  );
}

/** Field validation identical to the web createListing handler. Returns an error string or null. */
function validateListingFields(args: CreateListingArgs): string | null {
  if (typeof args.title !== "string" || !args.title.trim()) return "title is required";
  if (typeof args.description !== "string" || !args.description.trim()) return "description is required";
  if (
    typeof args.price_usd_cents !== "number" ||
    !Number.isInteger(args.price_usd_cents) ||
    args.price_usd_cents < 0
  ) {
    return "price_usd_cents must be a non-negative integer (USD cents)";
  }
  if (args.goods_type !== "physical" && args.goods_type !== "digital") {
    return 'goods_type must be "physical" or "digital"';
  }
  if (args.ipfs_hash !== undefined && args.ipfs_hash !== null && args.ipfs_hash !== "") {
    if (typeof args.ipfs_hash !== "string" || !isPlausibleCid(args.ipfs_hash.trim())) {
      return "ipfs_hash must be a valid IPFS CID (from upload_digital_good)";
    }
  }
  // Pre-publish safety gate — HCS is append-only, blocked content must never reach the chain.
  const gateTitle = checkContent(args.title.trim(), "listing title");
  if (!gateTitle.allowed) return gateTitle.reason ?? "listing title blocked by safety filter";
  const gateDesc = checkContent(args.description.trim(), "listing description");
  if (!gateDesc.allowed) return gateDesc.reason ?? "listing description blocked by safety filter";
  return null;
}

/**
 * Step 1: prepare a marketplace listing for the agent's own HCS submit.
 * Step 2 (hcs_tx_id present): verify the submit on-chain and confirm.
 *
 * The server never signs, never submits, never holds keys — same
 * prepare-don't-execute invariant as prepare_agent_message.
 */
export async function createListingTool(
  args: CreateListingArgs,
  injected: MarketplaceToolDeps = {},
): Promise<PreparedListing | ConfirmedListing | { error: string }> {
  const fetchFn = injected.fetchFn ?? fetch;
  const deps = injected.townhallDeps ?? defaultDeps();
  const quotaStore = injected.quotaStore ?? globalQuotaStore();

  if (!args || typeof args !== "object") return { error: "arguments are required" };

  const limited = await ipRateLimit("mcp-create-listing", 60, 60_000);
  if (limited) return { error: limited };

  const identity = await resolveAgentIdentity(args?.agent_username, fetchFn);
  if ("error" in identity) return identity;

  const restricted = await restrictionError(deps, identity.wallet);
  if (restricted) return { error: restricted };

  const fieldError = validateListingFields(args);
  if (fieldError) return { error: fieldError };

  const topic = getTopicId("market");
  if (!topic) return { error: 'marketplace topic is not configured (TOWNHALL_TOPIC_MARKET)' };

  const txId =
    typeof args.hcs_tx_id === "string" && args.hcs_tx_id.trim() ? args.hcs_tx_id.trim() : null;

  // The listing id is minted once in step 1 and bound into the HCS
  // message; step 2 must echo it back so the on-chain content check
  // compares against the same id (mirrors the web flow, where the client
  // generates the id and includes it in both the message and the body).
  let id: string;
  const rawListingId =
    typeof args.listing_id === "string" && args.listing_id.trim() ? args.listing_id.trim() : null;
  if (txId) {
    if (!rawListingId) {
      return {
        error:
          "listing_id is required for step 2 — pass the listing_id returned by step 1 (the id bound into your HCS message)",
      };
    }
    if (!TOWNHALL_ID_RE.test(rawListingId)) {
      return { error: "listing_id must be 8–64 chars: lowercase letters, numbers, and hyphens" };
    }
    id = rawListingId;
  } else if (rawListingId) {
    if (!TOWNHALL_ID_RE.test(rawListingId)) {
      return { error: "listing_id must be 8–64 chars: lowercase letters, numbers, and hyphens" };
    }
    id = rawListingId;
  } else {
    id = makeListingId(args.title);
  }
  const title = args.title.trim();
  const description = args.description.trim();
  const ipfsHash =
    args.ipfs_hash !== undefined && args.ipfs_hash !== null && args.ipfs_hash !== ""
      ? args.ipfs_hash.trim()
      : null;

  // The expected on-chain message — identical shape to the web
  // createListing handler's expectedContent, so the same
  // verifyUserHcsTx content binding applies.
  const message: Record<string, unknown> = {
    v: 1,
    kind: "listing",
    author: identity.username,
    id,
    seller: identity.wallet,
    sellerUsername: identity.username,
    title,
    description,
    priceUsdCents: args.price_usd_cents,
    goodsType: args.goods_type,
    ipfsHash,
    status: "active",
  };

  // --- Step 1: prepare ---
  if (!txId) {
    // Spam guard: bound free (off-chain) prepares per wallet per day.
    const limit = quotaLimitFromEnv("MCP_LISTING_PREPARE_DAILY_QUOTA", 20);
    let q;
    try {
      q = await quotaStore.consume("mcp:listing-prepare", identity.wallet, limit);
    } catch (e) {
      console.error(`[mcp-marketplace] prepare quota store unreachable: ${e instanceof Error ? e.message : String(e)}`);
      return { error: "temporarily unavailable — please retry in a moment" };
    }
    if (!q.allowed) {
      const body = quotaExceededBody(q, `daily listing-prepare limit reached (${limit}/day)`);
      return { error: body.error as string };
    }
    return {
      prepared: true,
      step: "submit",
      listing_id: id,
      topic,
      payout_address: identity.wallet,
      message,
      instructions:
        "STEP 1 of 2 — your listing is prepared but NOTHING is on-chain yet. " +
        "1) JSON-encode the `message` object EXACTLY as returned (same fields, same values — the confirm step byte-binds them). " +
        `2) Submit it as an HCS message to topic ${topic} signed with YOUR OWN Hedera key — the wallet that owns your "${identity.username}" blockpage (${identity.wallet}). ` +
        "Use the Hedera SDK TopicMessageSubmitTransaction or your wallet's HCS submit; you pay the small HCS network fee yourself. " +
        "3) Call create_listing again with the SAME fields plus hcs_tx_id set to the Hedera transaction id of your submit (0.0.x@seconds.nanos) " +
        `AND listing_id set to "${id}" (the id from this step 1 — it is bound into your HCS message and must match). ` +
        "The server verifies on-chain that the tx was paid by your wallet, went to the market topic, and carries the exact message — then confirms the listing. " +
        "Never include secrets or keys in the message; it is public on Hedera mainnet.",
    };
  }

  // --- Step 2: confirm ---
  // Synthetic session: verifyUserHcsTx only reads session.address (the
  // expected payer). The agent proved wallet ownership by paying for the
  // HCS submit from the page owner's wallet.
  const session: VerifiedSession = {
    address: identity.wallet,
    chainId: 295,
    nonce: "mcp-create-listing",
    expiresAtMs: Date.now() + 5 * 60 * 1000,
  };
  const verified = await verifyUserHcsTx(deps, session, txId, topic, message);
  if (verified) {
    const body = verified.json as { error?: string };
    return { error: typeof body?.error === "string" ? body.error : "HCS transaction verification failed" };
  }
  return {
    confirmed: true,
    listing_id: id,
    listing_url: `${SITE_URL}/marketplace/${encodeURIComponent(id)}`,
    seller: identity.username,
    payout_address: identity.wallet,
    hcs_tx_id: txId,
    note:
      "Listing confirmed on Hedera mainnet — it is live in the marketplace. " +
      "Buyers pay via the Tips contract (0.0.10854060): one atomic transaction splits 98% to your wallet and 2% to the treasury. " +
      "You can cancel it later from the dapp with your wallet.",
  };
}

/* ------------------------------------------------------------------ */
/* upload_digital_good                                                  */
/* ------------------------------------------------------------------ */

export interface UploadDigitalGoodArgs {
  agent_username: string;
  /** Base64-encoded file bytes (max 10 MB decoded). */
  file_base64: string;
  /** Original filename (extension hints the kind; the stored name is neutralized for privacy). */
  filename: string;
}

export interface DigitalGoodUpload {
  cid: string;
  kind: "image" | "pdf" | "zip";
  note: string;
}

/** The file kinds a marketplace digital good may be — same gate as the web upload route. */
function sniffGoodKind(bytes: Uint8Array): "image" | "pdf" | "zip" | null {
  const kind = sniffMediaKind(bytes);
  if (kind === "jpeg" || kind === "png" || kind === "gif" || kind === "webp") return "image";
  // PDF: %PDF- ; ZIP: PK\x03\x04 (also covers docx/epub, which are zips)
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "zip";
  return null;
}

/**
 * Privacy: the upload filename is fully agent-controlled. Replace it with a
 * neutral name — PII must never reach storage. Only a safe extension is kept.
 */
function safeGoodFilename(raw: unknown, kind: string): string {
  const name = typeof raw === "string" ? raw : "";
  const dot = name.lastIndexOf(".");
  let ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (!/^[a-z0-9]{2,5}$/.test(ext)) ext = { pdf: "pdf", zip: "zip" }[kind] ?? "bin";
  return `digital-good-${Date.now()}.${ext}`;
}

const GOOD_MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
};

/**
 * Pin a marketplace digital-good file to IPFS and get back its CID, for
 * binding into a create_listing call. Same quota bucket as the web route
 * (pin:digital-good, DIGITAL_GOOD_DAILY_QUOTA, default 5/day) — the
 * agent's wallet shares the limit with the dapp, so one seller can't burn
 * the Pinata allowance from either surface.
 */
export async function uploadDigitalGoodTool(
  args: UploadDigitalGoodArgs,
  injected: MarketplaceToolDeps = {},
): Promise<DigitalGoodUpload | { error: string }> {
  const fetchFn = injected.fetchFn ?? fetch;
  const deps = injected.townhallDeps ?? defaultDeps();
  const quotaStore = injected.quotaStore ?? globalQuotaStore();
  const publishFn = injected.publishFn ?? publishDigitalGood;

  if (!args || typeof args !== "object") return { error: "arguments are required" };

  const limited = await ipRateLimit("mcp-upload-good", 30, 60_000);
  if (limited) return { error: limited };

  const identity = await resolveAgentIdentity(args?.agent_username, fetchFn);
  if ("error" in identity) return identity;

  const restricted = await restrictionError(deps, identity.wallet);
  if (restricted) return { error: restricted };

  // Same quota as the web route: same bucket, same per-wallet key, same env limit.
  const limit = quotaLimitFromEnv("DIGITAL_GOOD_DAILY_QUOTA", 5);
  let q;
  try {
    q = await quotaStore.consume("pin:digital-good", identity.wallet, limit);
  } catch (e) {
    console.error(`[mcp-marketplace] upload quota store unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return { error: "temporarily unavailable — please retry in a moment" };
  }
  if (!q.allowed) {
    return { error: quotaExceededBody(q, `daily digital-good upload limit reached (${limit}/day)`).error as string };
  }

  if (typeof args.file_base64 !== "string") {
    return { error: "file_base64 is required" };
  }
  const b64text = args.file_base64.trim().replace(/\s+/g, "");
  if (!b64text) return { error: "empty file" };
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(b64text, "base64"));
  } catch {
    return { error: "file_base64 is not valid base64" };
  }
  // Buffer.from never throws on bad base64 — it silently skips invalid
  // chars. Re-encode and compare to catch garbage input.
  const recoded = Buffer.from(bytes).toString("base64").replace(/=+$/, "");
  const given = b64text.replace(/=+$/, "");
  if (recoded !== given) return { error: "file_base64 is not valid base64" };
  if (bytes.length === 0) return { error: "empty file" };
  if (bytes.length > MAX_DIGITAL_GOOD_BYTES) {
    return { error: `file too large (max ${MAX_DIGITAL_GOOD_BYTES / 1024 / 1024} MB)` };
  }

  const kind = sniffGoodKind(bytes);
  if (!kind) {
    return { error: "unsupported file type — digital goods must be an image (JPEG/PNG/GIF/WebP), PDF, or ZIP" };
  }
  const sniffed = sniffMediaKind(bytes);
  const mime = GOOD_MIME[sniffed] ?? (kind === "pdf" ? "application/pdf" : "application/zip");

  try {
    const { cid } = await publishFn(bytes, safeGoodFilename(args.filename, kind), mime);
    return {
      cid,
      kind,
      note:
        "File pinned to IPFS. Pass this CID as ipfs_hash to create_listing to attach it to your listing — " +
        "the CID is bound into the on-chain listing message so buyers can prove this exact file was the one listed.",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "PINATA_UNAVAILABLE") {
      return { error: "file pinning is temporarily unavailable" };
    }
    console.error(`[mcp-marketplace] pin failed: ${msg}`);
    return { error: "file upload failed — try again in a moment" };
  }
}
