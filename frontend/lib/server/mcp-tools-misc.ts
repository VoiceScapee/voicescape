/**
 * Voicescape MCP server — P2/P3 parity tool implementations (v1).
 *
 * These seven tools close the audit gaps so agents can do what humans can:
 * browse the marketplace, prepare a purchase, follow/unfollow creators,
 * post proof-of-payment hire reviews, create fundraisers, and manage the
 * music block on their own blockpage.
 *
 * AGENT IDENTITY MODEL: every write tool takes `agent_username` — the
 * caller's registered blockpage — and resolves it ON-CHAIN via the
 * Registry contract (resolvePage). The tool acts as the page's owner
 * wallet. There is no wallet session: MCP agents hold their own keys
 * (or capability tokens) and sign anything on-chain themselves.
 *
 * NON-CUSTODIAL INVARIANT: prepare_purchase returns UNSIGNED calldata
 * exactly like prepare_agent_message returns an unsigned HCS payload —
 * this server never signs, never holds keys, never submits.
 *
 * This file is deliberately separate from mcp-tools.ts /
 * mcp-tool-registry.ts (the registry snippet for these tools lives in
 * mcp-tools-misc.registry-snippet.txt, pasted into the registry by hand).
 */

import { createHash } from "node:crypto";
import { ethers } from "ethers";
import { TIPS_ABI } from "../tx";
import { canonicalAddress } from "../session-message";
import { siteUrl } from "../seo";
import { parseMusicUrl } from "../music";
import { isValidMusicTrack } from "../schema";
import type { MusicTrack } from "../schema";
import {
  USERNAME_RE,
  usernameValidationError,
  lookupBlockpage,
  MIRROR_BASE,
} from "./mcp-tools";
import {
  defaultDeps,
  searchListings,
  getListingById,
  type SearchListingsParams,
  type TownhallDeps,
} from "./townhall/handlers";
import { followPage, unfollowPage, readFollowList } from "../follows";
import { recordFollowEvent } from "./notify";
import { getKvStore, type KvStore } from "./store";
import { globalQuotaStore, quotaLimitFromEnv } from "./quota";
import {
  verifyReviewTx,
  claimReviewTx,
  releaseReviewTx,
  addReview,
  getReviewSummary,
  validateReviewInput,
} from "./agents/reviews";
import { checkContent } from "./townhall/content-filter";
import { getTipsAddress } from "../contracts";
import { mirrorBaseUrl } from "./townhall/topics";
import { writeGoal, type GoalDeps } from "./goals";

type FetchFn = typeof fetch;

/** Tips contract (mainnet). buyListing splits 98% to seller / 2% to treasury atomically. */
const TIPS_CONTRACT_ID = "0.0.10854060";
/** EVM address of the Tips contract (lib/contracts.ts MAINNET_TIPS_EVM). */
const TIPS_CONTRACT_EVM = "0x571D6d0C5D5ee7Fc1e47283Ad864305b7f7A88e0";

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
/** CIDv0 (Qm…) or CIDv1 (baf…) — the only forms the Registry ever stores. */
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{50,100})$/;
/** Pinata first: the dapp pins page JSON through Pinata server-side. */
const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
];
const IPFS_FETCH_TIMEOUT_MS = 10_000;
/** Blockpage JSON is a few KB — cap the read so a hostile CID can't blow memory. */
const IPFS_MAX_BYTES = 256 * 1024;
const MAX_MUSIC_TRACKS = 50;

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

export interface AgentIdentity {
  /** Normalized lowercase username. */
  name: string;
  /** Owner wallet, canonical lowercase 0x EVM address. */
  ownerEvm: string;
  /** Current page-content CID from the Registry (may be empty). */
  ipfsHash: string;
}

/**
 * Resolve an agent's claimed username to its on-chain identity.
 * Fail-fast: unknown names and unresolvable owners are errors, never
 * silent assumptions.
 */
async function resolveAgentIdentity(
  agentUsername: unknown,
  fetchFn: FetchFn,
): Promise<AgentIdentity | { error: string }> {
  const raw = (agentUsername ?? "").toString();
  const name = raw.trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return { error: usernameValidationError(agentUsername) };
  const page = await lookupBlockpage(name, fetchFn);
  if (!page.found) {
    return { error: `@${name} is not a registered blockpage — check the name with lookup_blockpage` };
  }
  const ownerEvm = (page.owner_evm ?? "").toLowerCase();
  if (!EVM_RE.test(ownerEvm)) {
    return { error: `could not resolve the on-chain owner of @${name} — try again in a moment` };
  }
  return { name, ownerEvm, ipfsHash: page.ipfs_hash ?? "" };
}

/** Resolve a target page's owner — same on-chain source as the agent path. */
async function resolveTargetOwner(
  targetUsername: unknown,
  fetchFn: FetchFn,
): Promise<{ ownerEvm: string } | { error: string }> {
  const raw = (targetUsername ?? "").toString();
  const name = raw.trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return { error: usernameValidationError(targetUsername) };
  const page = await lookupBlockpage(name, fetchFn);
  if (!page.found) return { error: `no page is registered for "${name}"` };
  const ownerEvm = (page.owner_evm ?? "").toLowerCase();
  if (!EVM_RE.test(ownerEvm)) {
    return { error: `could not resolve the on-chain owner of "${name}" — try again in a moment` };
  }
  return { ownerEvm };
}

/** FollowRegistry adapter over the Registry-contract read (same source the web route uses). */
function followRegistryAdapter(fetchFn: FetchFn) {
  return {
    async resolvePage(username: string): Promise<{ owner: string; ownerType: 0 | 1 } | null> {
      const r = await resolveTargetOwner(username, fetchFn);
      if ("error" in r) return null;
      return { owner: r.ownerEvm, ownerType: 1 as const };
    },
  };
}

/**
 * Per-agent-username daily quota (fail closed on store failure, like the
 * web routes). Buckets are separate per tool so a follow spree can't eat
 * the review budget.
 */
async function consumeMcpQuota(
  bucket: string,
  key: string,
  envName: string,
  fallback: number,
): Promise<{ error: string } | null> {
  const limit = quotaLimitFromEnv(envName, fallback);
  let res;
  try {
    res = await globalQuotaStore().consume(bucket, key, limit);
  } catch {
    return { error: "temporarily unavailable — please retry in a moment" };
  }
  if (!res.allowed) {
    return {
      error:
        `daily quota exceeded (${limit}/day, resets ${res.resetsAt}) — ` +
        `try again after UTC midnight`,
    };
  }
  return null;
}

/** HBAR/USD from the mirror node exchangerate endpoint. Null when unreadable. */
async function fetchHbarUsd(fetchFn: FetchFn): Promise<number | null> {
  try {
    const res = await fetchFn(`${MIRROR_BASE}/network/exchangerate`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      current_rate?: { cent_equivalent?: unknown; hbar_equivalent?: unknown };
    };
    const cent = body?.current_rate?.cent_equivalent;
    const hb = body?.current_rate?.hbar_equivalent;
    if (typeof cent !== "number" || typeof hb !== "number" || cent <= 0 || hb <= 0) return null;
    const price = cent / hb / 100;
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/** USD → tinybars at a given HBAR/USD price. */
function usdToTinybar(usd: number, hbarUsd: number): bigint {
  return BigInt(Math.round((usd / hbarUsd) * 100_000_000));
}

/** Read raw bytes from an IPFS gateway, capped. Null on any failure. */
async function fetchIpfsBytes(cid: string, fetchFn: FetchFn): Promise<Buffer | null> {
  for (const gw of IPFS_GATEWAYS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IPFS_FETCH_TIMEOUT_MS);
    try {
      const res = await fetchFn(gw + cid, { signal: ctrl.signal });
      if (!res.ok || !res.body) continue;
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > IPFS_MAX_BYTES) break;
          chunks.push(value);
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
      }
      if (bytes > IPFS_MAX_BYTES) continue;
      return Buffer.concat(chunks);
    } catch {
      /* try the next gateway */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Tool 1: list_marketplace (read-only)                                 */
/* ------------------------------------------------------------------ */

export interface ListMarketplaceArgs {
  /** Free-text match against title + description. */
  q?: string;
  /** "physical" | "digital". */
  category?: string;
  /** Price bounds in USD cents. */
  min_price_cents?: number;
  max_price_cents?: number;
  /** "newest" (default) | "price-asc" | "price-desc". */
  sort?: string;
  /** 1..100, default 50. */
  limit?: number;
}

export interface MarketplaceListingView {
  id: string;
  seller: string;
  sellerUsername: string | null;
  title: string;
  description: string;
  priceUsdCents: number;
  goodsType: string;
  ipfsHash: string | null;
  status: string;
  ts: string;
  url: string;
}

/**
 * Browse/search ACTIVE marketplace listings — the agent equivalent of the
 * /marketplace UI. Thin wrapper over the existing public searchListings
 * handler (same HCS market topic, same filters, same active-only rule).
 * Read-only; never touches keys.
 */
export async function listMarketplaceTool(
  args: ListMarketplaceArgs,
  depsOverride?: TownhallDeps,
): Promise<{ listings: MarketplaceListingView[]; count: number } | { error: string }> {
  const params: SearchListingsParams = {};
  if (args.q !== undefined) params.q = String(args.q);
  if (args.category !== undefined) {
    const c = String(args.category).trim().toLowerCase();
    if (c !== "physical" && c !== "digital") {
      return { error: 'category must be "physical" or "digital"' };
    }
    params.category = c;
  }
  for (const [key, field] of [
    ["min_price_cents", "minPriceCents"],
    ["max_price_cents", "maxPriceCents"],
  ] as const) {
    const v = (args as Record<string, unknown>)[key];
    if (v !== undefined) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        return { error: `${key} must be a non-negative number` };
      }
      params[field] = n;
    }
  }
  if (args.sort !== undefined) {
    const s = String(args.sort).trim().toLowerCase();
    if (s !== "newest" && s !== "price-asc" && s !== "price-desc") {
      return { error: 'sort must be "newest", "price-asc", or "price-desc"' };
    }
    params.sort = s;
  }
  if (args.limit !== undefined) {
    const n = Number(args.limit);
    if (!Number.isFinite(n) || n < 1) return { error: "limit must be a positive number" };
    params.limit = n; // searchListings clamps to 1..100
  }

  let result: { status: number; json: unknown };
  try {
    result = await searchListings(depsOverride ?? defaultDeps(), params, siteUrl());
  } catch {
    return { error: "marketplace search unavailable — try again in a moment" };
  }
  if (result.status !== 200) {
    const msg =
      (result.json as { error?: unknown } | null)?.error;
    return {
      error:
        typeof msg === "string" && msg
          ? msg
          : "marketplace search unavailable — try again in a moment",
    };
  }
  return result.json as { listings: MarketplaceListingView[]; count: number };
}

/* ------------------------------------------------------------------ */
/* Tool 2: prepare_purchase (unsigned buyListing — server never signs)  */
/* ------------------------------------------------------------------ */

export interface PreparePurchaseArgs {
  /** Marketplace listing id, e.g. "bacon-badge". */
  listing_id: string;
}

export interface PreparedPurchase {
  listing: {
    id: string;
    title: string;
    seller: string;
    price_usd_cents: number;
    status: string;
  };
  /** Tips contract in 0.0.x form — the ContractId for the SDK call. */
  contract: string;
  contract_evm: string;
  /** Canonical Solidity signature of the called function. */
  function: string;
  function_selector: string;
  /** Hex-encoded buyListing(seller, listingRef) calldata — UNSIGNED. */
  unsigned_calldata: string;
  /** Payable value the buyer attaches (the listing price in HBAR). */
  value_tinybar: string;
  value_hbar: string;
  hbar_usd: number;
  hbar_usd_source: string;
  instructions: string;
}

/**
 * Prepare an unsigned buyListing purchase for an agent's own wallet to
 * sign. Mirrors the prepare_* pattern (prepare_agent_claim,
 * prepare_agent_message): the server builds exact calldata, the agent
 * signs with its OWN key. The buyer is the transaction's signer/payer
 * (msg.sender) — buyListing takes (seller, listingRef) as params.
 *
 * Non-custodial invariant: nothing here is signed and nothing is
 * submitted. The contract splits 98% to the seller and 2% to the
 * treasury atomically — no escrow, no platform custody.
 */
export async function preparePurchaseTool(
  args: PreparePurchaseArgs,
  depsOverride?: TownhallDeps,
  fetchFn: FetchFn = fetch,
): Promise<PreparedPurchase | { error: string }> {
  const id = (args.listing_id ?? "").toString().trim();
  if (!id) return { error: "listing_id is required" };

  const deps = depsOverride ?? defaultDeps();
  let listing;
  try {
    listing = await getListingById(deps, id);
  } catch {
    return { error: "could not read the listing — try again in a moment" };
  }
  if (!listing) return { error: `listing "${id}" not found` };
  if (listing.status !== "active") {
    return { error: `listing "${id}" is not for sale (status: ${listing.status})` };
  }
  if (!(listing.priceUsdCents > 0)) {
    return { error: `listing "${id}" has no valid price` };
  }

  // Seller payout address: 0x as-is, 0.0.x → long-zero EVM form, anything
  // else is treated as a username and resolved on-chain.
  let sellerEvm = canonicalAddress((listing.seller ?? "").toString());
  if (!sellerEvm) {
    const uname =
      (listing.sellerUsername ?? listing.seller ?? "").toString().trim().toLowerCase();
    if (!USERNAME_RE.test(uname)) {
      return { error: `could not resolve the seller of listing "${id}"` };
    }
    const sp = await lookupBlockpage(uname, fetchFn);
    if (!sp.found || !sp.owner_evm) {
      return { error: `could not resolve the seller of listing "${id}"` };
    }
    sellerEvm = sp.owner_evm.toLowerCase();
  }

  const hbarUsd = await fetchHbarUsd(fetchFn);
  if (hbarUsd === null) {
    return { error: "could not read the current HBAR/USD price — retry in a moment" };
  }
  const tinybar = usdToTinybar(listing.priceUsdCents / 100, hbarUsd);
  if (tinybar <= 0n) {
    return { error: "computed purchase value is zero — retry in a moment" };
  }

  const iface = new ethers.Interface(TIPS_ABI);
  const calldata = iface.encodeFunctionData("buyListing", [sellerEvm, listing.id]);
  const selector = iface.getFunction("buyListing")!.selector;
  const valueHbar = (Number(tinybar) / 100_000_000).toFixed(8);

  return {
    listing: {
      id: listing.id,
      title: listing.title,
      seller: listing.sellerUsername ?? listing.seller,
      price_usd_cents: listing.priceUsdCents,
      status: listing.status,
    },
    contract: TIPS_CONTRACT_ID,
    contract_evm: TIPS_CONTRACT_EVM,
    function: "buyListing(address seller, string listingRef)",
    function_selector: selector,
    unsigned_calldata: calldata,
    value_tinybar: tinybar.toString(),
    value_hbar: valueHbar,
    hbar_usd: hbarUsd,
    hbar_usd_source: "Hedera mainnet mirror node /network/exchangerate (current_rate)",
    instructions:
      "This calldata is UNSIGNED — the server never signed it and never will. " +
      `Sign and submit it with YOUR OWN Hedera key as the buyer: build a ContractExecuteTransaction ` +
      `targeting ContractId ${TIPS_CONTRACT_ID}, gas 300_000, function "buyListing" with params ` +
      `(address ${sellerEvm}, string "${listing.id}") — or pass the unsigned_calldata hex as the raw ` +
      `function params — attach ${valueHbar} HBAR (${tinybar.toString()} tinybar) as the payable value, ` +
      `sign with the buyer's key, and submit. You are the buyer because you sign: the contract pays ` +
      `msg.sender's value 98% to the seller and 2% to the treasury in the same atomic transaction — ` +
      `no escrow, no platform custody. Verify the purchase afterward with verify_purchase. ` +
      `Never put your private key in a tool argument or chat message.`,
  };
}

/* ------------------------------------------------------------------ */
/* Tool 3: follow_creator                                               */
/* Tool 4: unfollow_creator                                             */
/* ------------------------------------------------------------------ */

export interface FollowCreatorArgs {
  /** The caller's registered blockpage (identity, verified on-chain). */
  agent_username: string;
  /** The page to follow. */
  target_username: string;
}

export interface FollowResult {
  ok: true;
  agent_username: string;
  target_username: string;
  following: string[];
}

export interface FollowOverrides {
  fetchFn?: FetchFn;
  store?: KvStore;
}

/**
 * Follow a creator's page as an agent. Identity = agent_username resolved
 * on-chain (its owner wallet is the follower). Rate-limited per agent
 * (daily quota, like the web route). New follows notify the creator via
 * the standard follow-event pipeline (best-effort).
 */
export async function followCreatorTool(
  args: FollowCreatorArgs,
  overrides?: FollowOverrides,
): Promise<FollowResult | { error: string }> {
  const fetchFn = overrides?.fetchFn ?? fetch;
  const agent = await resolveAgentIdentity(args.agent_username, fetchFn);
  if ("error" in agent) return agent;

  const target = (args.target_username ?? "").toString().trim().toLowerCase();
  if (!USERNAME_RE.test(target)) return { error: usernameValidationError(args.target_username) };

  const quotaHit = await consumeMcpQuota(
    "mcp-follows",
    agent.name,
    "FOLLOWS_DAILY_QUOTA",
    100,
  );
  if (quotaHit) return quotaHit;

  const store = overrides?.store ?? getKvStore();
  let before: string[];
  try {
    before = await readFollowList(store, agent.ownerEvm);
  } catch {
    return { error: "could not load the following list — try again in a moment" };
  }
  const result = await followPage({
    store,
    wallet: agent.ownerEvm,
    username: target,
    registry: followRegistryAdapter(fetchFn),
  });
  if (!result.ok) {
    const message =
      result.error === "unknown-username"
        ? `no page is registered for "${target}"`
        : result.error === "self-follow"
          ? "you can't follow your own page"
          : "invalid username";
    return { error: message };
  }
  // First-time follows notify the creator — best-effort, never breaks
  // the follow itself.
  if (!before.includes(target)) {
    try {
      await recordFollowEvent(store, agent.ownerEvm, target);
    } catch {
      /* follow-event logging is best-effort */
    }
  }
  return {
    ok: true,
    agent_username: agent.name,
    target_username: target,
    following: result.following,
  };
}

/**
 * Unfollow a creator's page as an agent. Idempotent — unfollowing a page
 * you don't follow is not an error. No quota (not a growth vector — same
 * as the web route, which only quotas follows).
 */
export async function unfollowCreatorTool(
  args: FollowCreatorArgs,
  overrides?: FollowOverrides,
): Promise<FollowResult | { error: string }> {
  const fetchFn = overrides?.fetchFn ?? fetch;
  const agent = await resolveAgentIdentity(args.agent_username, fetchFn);
  if ("error" in agent) return agent;

  const target = (args.target_username ?? "").toString().trim().toLowerCase();
  if (!USERNAME_RE.test(target)) return { error: usernameValidationError(args.target_username) };

  const store = overrides?.store ?? getKvStore();
  let following: string[];
  try {
    following = await unfollowPage(store, agent.ownerEvm, target);
  } catch {
    return { error: "could not update the following list — try again in a moment" };
  }
  return {
    ok: true,
    agent_username: agent.name,
    target_username: target,
    following,
  };
}

/* ------------------------------------------------------------------ */
/* Tool 5: post_hire_review (proof-of-payment, verified on-chain)       */
/* ------------------------------------------------------------------ */

export interface PostHireReviewArgs {
  /** The reviewer's registered blockpage (identity, verified on-chain). */
  agent_username: string;
  /** The agent page being reviewed (must be registered). */
  target_username: string;
  /** Integer 1..5. */
  rating: number;
  /** Review text, ≤500 chars (content-filtered). */
  text: string;
  /** Settled Tips-contract tx proving this agent paid the target's owner. */
  proof_tx_id: string;
}

/**
 * Post a proof-of-payment hire review. Reuses the exact web-route
 * verification: the proof tx must be a SUCCESSFUL Tips-contract call
 * whose TipSent/PurchaseCompleted event proves the REVIEWER's wallet
 * (resolved on-chain from agent_username) paid the TARGET page's owner.
 * One review per transaction (claimed atomically); no self-reviews;
 * content-filtered. Nothing is fabricated — every review is backed by a
 * settled on-chain payment anyone can verify on HashScan.
 */
export async function postHireReviewTool(
  args: PostHireReviewArgs,
  fetchFn: FetchFn = fetch,
): Promise<{ review: unknown; summary: unknown } | { error: string }> {
  const agent = await resolveAgentIdentity(args.agent_username, fetchFn);
  if ("error" in agent) return agent;

  const target = (args.target_username ?? "").toString().trim().toLowerCase();
  if (!USERNAME_RE.test(target)) return { error: usernameValidationError(args.target_username) };
  const targetOwner = await resolveTargetOwner(target, fetchFn);
  if ("error" in targetOwner) return targetOwner;

  if (agent.ownerEvm === targetOwner.ownerEvm) {
    return { error: "cannot review your own page" };
  }

  const quotaHit = await consumeMcpQuota(
    "mcp-hire-reviews",
    agent.name,
    "MCP_HIRE_REVIEW_DAILY_QUOTA",
    20,
  );
  if (quotaHit) return quotaHit;

  const input = validateReviewInput({
    txId: args.proof_tx_id,
    rating: args.rating,
    text: args.text,
  });
  if (!input.ok) return { error: input.error };

  if (input.input.text) {
    const check = checkContent(input.input.text, "review");
    if (!check.allowed) {
      return { error: `review blocked: ${check.reason ?? "not allowed"}` };
    }
  }

  const tips = getTipsAddress();
  if (!tips) {
    return { error: "tips contract is not configured — try again in a moment" };
  }
  // verifyReviewTx compares against the mirror node's entity_id (0.0.x
  // form); getTipsAddress() returns the EVM form — normalize to the known
  // mainnet id (same pattern as trust-score.ts). NOTE: the web route
  // POST /api/agents/[agent]/reviews passes the EVM form straight through,
  // which can never match entity_id — flagged in the build report.
  const tipsId = tips.startsWith("0x") ? TIPS_CONTRACT_ID : tips;
  const proven = await verifyReviewTx(
    input.input.txId,
    agent.ownerEvm,
    targetOwner.ownerEvm,
    { fetchFn, mirrorBaseUrl: mirrorBaseUrl(), tipsAddress: tipsId },
  );
  if (!proven.ok) return { error: proven.error };

  let claimed: boolean;
  try {
    claimed = await claimReviewTx(input.input.txId);
  } catch {
    return { error: "could not record the review — try again in a moment" };
  }
  if (!claimed) {
    return { error: "this transaction already backs a review" };
  }

  const review = {
    txId: input.input.txId,
    kind: proven.kind,
    reviewer: agent.ownerEvm,
    reviewerUsername: agent.name,
    rating: input.input.rating,
    text: input.input.text,
    timestamp: new Date().toISOString(),
  };
  try {
    await addReview(target, review);
  } catch {
    // Release the claim so the proof isn't burned with no recourse.
    try {
      await releaseReviewTx(input.input.txId);
    } catch {
      /* best-effort */
    }
    return { error: "could not record the review — try again in a moment" };
  }

  let summary: unknown = null;
  try {
    summary = await getReviewSummary(target);
  } catch {
    summary = null;
  }
  return { review, summary };
}

/* ------------------------------------------------------------------ */
/* Tool 6: create_fundraiser                                            */
/* ------------------------------------------------------------------ */

export interface CreateFundraiserArgs {
  /** The caller's registered blockpage — the fundraiser is created on this page. */
  agent_username: string;
  /** Funding target in HBAR (>0, ≤1,000,000). */
  target_hbar: number;
  /** Campaign title, ≤80 chars (optional). */
  title?: string;
}

export interface CreateFundraiserOverrides {
  fetchFn?: FetchFn;
  /** Injected GoalDeps for tests; production builds them from the on-chain owner. */
  deps?: GoalDeps;
}

/**
 * Non-null sentinel credential: writeGoal requires SOME credential, but the
 * MCP path authenticates via the on-chain page owner (resolved from
 * agent_username), not a wallet session. The injected verifySession
 * returns that owner, so requireOwner's owner check passes exactly as it
 * does for a matching wallet session on the web route.
 */
const MCP_AGENT_CRED = { source: "mcp-tool", kind: "agent-username" };

/**
 * Create (or replace) the funding goal for the agent's own blockpage —
 * the agent equivalent of POST /api/goals. Reuses writeGoal wholesale:
 * input validation, content filter, campaign-baseline snapshot (a save
 * after a completed campaign starts a NEW campaign; editing a live one
 * keeps its progress), and fundraiser-board indexing.
 *
 * Donations are ordinary on-chain tips to the page (the proven 98/2 Tips
 * path) — the board derives progress from the mirror node; no new money
 * movement, no custody.
 */
export async function createFundraiserTool(
  args: CreateFundraiserArgs,
  overrides?: CreateFundraiserOverrides,
): Promise<{ ok: true; fundraiser: unknown; note: string } | { error: string }> {
  const fetchFn = overrides?.fetchFn ?? fetch;
  const agent = await resolveAgentIdentity(args.agent_username, fetchFn);
  if ("error" in agent) return agent;

  const quotaHit = await consumeMcpQuota(
    "mcp-fundraisers",
    agent.name,
    "MCP_FUNDRAISER_DAILY_QUOTA",
    20,
  );
  if (quotaHit) return quotaHit;

  const deps: GoalDeps =
    overrides?.deps ??
    {
      store: getKvStore(),
      verifySession: async () => ({ ok: true as const, address: agent.ownerEvm }),
      resolveOwner: async () => agent.ownerEvm,
      // readAllTimeHbar omitted — writeGoal falls back to the mirror-node
      // reader for the campaign baseline snapshot.
    };

  let result: { status: number; json: unknown };
  try {
    result = await writeGoal(
      deps,
      agent.name,
      { targetHbar: args.target_hbar, title: args.title },
      MCP_AGENT_CRED,
    );
  } catch {
    return { error: "could not create the fundraiser — try again in a moment" };
  }
  if (result.status !== 200) {
    const msg = (result.json as { error?: unknown } | null)?.error;
    return {
      error:
        typeof msg === "string" && msg ? msg : "could not create the fundraiser",
    };
  }
  return {
    ok: true,
    fundraiser: (result.json as { goal?: unknown }).goal ?? null,
    note:
      `Fundraiser live on @${agent.name}'s blockpage and the /fundraiser board. ` +
      `Donations are ordinary on-chain tips to the page (98% to the owner, 2% to the treasury, ` +
      `atomic) — progress updates automatically from the Hedera mirror node. The campaign leaves ` +
      `the board automatically when on-chain raised >= target.`,
  };
}

/* ------------------------------------------------------------------ */
/* Tool 7: manage_music (own blockpage only)                            */
/* ------------------------------------------------------------------ */

export interface ManageMusicArgs {
  /** The caller's registered blockpage — the music block must be on THIS page. */
  agent_username: string;
  /** "add" or "remove". */
  action: string;
  /** Spotify / YouTube / SoundCloud link (add: parse into a track; remove: match). */
  track_url?: string;
  /** IPFS CID of the owner's own upload (add only; alternative to track_url). */
  ipfs_cid?: string;
  /** Optional display metadata for an added track. */
  title?: string;
  artist?: string;
  /** Remove by track index (alternative to track_url match). */
  track_index?: number;
}

/**
 * Add or remove a track on the agent's OWN blockpage music block.
 *
 * Prepare-don't-execute: this returns the complete UPDATED page JSON —
 * nothing is pinned and nothing is published. The agent pins the JSON to
 * IPFS itself and calls updatePage(username, cid) on the Registry with its
 * own key. The server never signs.
 *
 * Scope is hard: the music block edited is always the one on
 * agent_username's page — there is no target-page parameter.
 */
export async function manageMusicTool(
  args: ManageMusicArgs,
  fetchFn: FetchFn = fetch,
): Promise<
  | {
      agent_username: string;
      action: "add" | "remove";
      track: MusicTrack;
      track_count: number;
      tracks: MusicTrack[];
      updated_page_json: Record<string, unknown>;
      page_sha256: string;
      note: string;
      next: string;
    }
  | { error: string }
> {
  const agent = await resolveAgentIdentity(args.agent_username, fetchFn);
  if ("error" in agent) return agent;

  const action = (args.action ?? "").toString().trim().toLowerCase();
  if (action !== "add" && action !== "remove") {
    return { error: 'action must be "add" or "remove"' };
  }

  const quotaHit = await consumeMcpQuota(
    "mcp-music",
    agent.name,
    "MCP_MUSIC_DAILY_QUOTA",
    50,
  );
  if (quotaHit) return quotaHit;

  if (!agent.ipfsHash || !CID_RE.test(agent.ipfsHash)) {
    return {
      error: `@${agent.name} has no pinned page content — publish a blockpage first`,
    };
  }
  const raw = await fetchIpfsBytes(agent.ipfsHash, fetchFn);
  if (!raw) {
    return { error: "could not read the current page content from IPFS — retry in a moment" };
  }
  let pageJson: Record<string, unknown>;
  try {
    pageJson = JSON.parse(raw.toString("utf-8")) as Record<string, unknown>;
  } catch {
    return { error: "the pinned page content is not valid JSON" };
  }
  if (!pageJson || typeof pageJson !== "object" || !Array.isArray(pageJson.blocks)) {
    return { error: "the pinned page content has no blocks array" };
  }
  const blocks = pageJson.blocks as Array<Record<string, unknown>>;

  let musicIdx = blocks.findIndex((b) => b && b.type === "music");
  if (musicIdx === -1 && action === "add") {
    blocks.push({ type: "music", title: "My music", tracks: [] });
    musicIdx = blocks.length - 1;
  }
  if (musicIdx === -1) {
    return { error: `@${agent.name} has no music block — nothing to remove` };
  }
  const musicBlock = blocks[musicIdx];
  const tracks: MusicTrack[] = Array.isArray(musicBlock.tracks)
    ? (musicBlock.tracks as unknown[]).filter(isValidMusicTrack)
    : [];

  let track: MusicTrack;
  if (action === "add") {
    if (tracks.length >= MAX_MUSIC_TRACKS) {
      return {
        error: `the music block is full (${MAX_MUSIC_TRACKS} tracks max) — remove one first`,
      };
    }
    const title = (args.title ?? "").toString().trim().slice(0, 120) || undefined;
    const artist = (args.artist ?? "").toString().trim().slice(0, 120) || undefined;
    if (args.ipfs_cid !== undefined) {
      const cid = args.ipfs_cid.toString().trim();
      if (!CID_RE.test(cid)) {
        return { error: "ipfs_cid must be a valid IPFS CID (Qm… or baf…)" };
      }
      track = { source: "ipfs", id: cid };
    } else if (args.track_url !== undefined) {
      const parsed = parseMusicUrl(args.track_url);
      if (!parsed) {
        return {
          error:
            "could not parse that music link — use a Spotify, YouTube, or SoundCloud link " +
            "(or ipfs_cid for your own upload)",
        };
      }
      track = parsed;
    } else {
      return { error: 'pass track_url (Spotify/YouTube/SoundCloud) or ipfs_cid for an add' };
    }
    if (title) track.title = title;
    if (artist) track.artist = artist;
    if (tracks.some((t) => t.source === track.source && t.id === track.id)) {
      return { error: "that track is already on the music block" };
    }
    tracks.push(track);
  } else {
    let removeIdx = -1;
    if (args.track_index !== undefined) {
      const n = Number(args.track_index);
      if (!Number.isInteger(n)) return { error: "track_index must be an integer" };
      removeIdx = n;
    } else if (args.track_url !== undefined) {
      const parsed = parseMusicUrl(args.track_url);
      if (parsed) {
        removeIdx = tracks.findIndex((t) => t.source === parsed.source && t.id === parsed.id);
      }
    } else {
      return { error: "pass track_index or track_url to choose the track to remove" };
    }
    if (removeIdx < 0 || removeIdx >= tracks.length) {
      return {
        error: `no track at that position — the music block has ${tracks.length} track(s)`,
      };
    }
    const removed = tracks.splice(removeIdx, 1)[0];
    if (!removed) {
      return { error: "could not remove that track — try again" };
    }
    track = removed;
  }

  blocks[musicIdx] = { ...musicBlock, tracks };
  const updated = { ...pageJson, blocks };
  const canonical = JSON.stringify(updated);
  const sha256 = createHash("sha256").update(canonical, "utf-8").digest("hex");

  return {
    agent_username: agent.name,
    action,
    track,
    track_count: tracks.length,
    tracks,
    updated_page_json: updated,
    page_sha256: sha256,
    note:
      "NOT published yet — this is the prepared new page content only. " +
      "The sha256 is over the JSON-serialized updated_page_json above.",
    next:
      `Pin the updated_page_json to IPFS yourself (it must be byte-identical to what you publish), ` +
      `then call updatePage("${agent.name}", "<the-new-cid>") on the Voicescape Registry contract ` +
      `(0.0.10854060), signed with the page owner's key — one signature, a few cents of HBAR ` +
      `network gas. The contract enforces owner-only, and the server never signs. ` +
      `Verify afterward with lookup_blockpage.`,
  };
}
