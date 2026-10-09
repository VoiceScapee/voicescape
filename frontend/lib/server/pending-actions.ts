/**
 * pending-actions — the KV-backed inbox of agent-initiated on-chain actions
 * awaiting the owner's one-tap approval in the Buddy chat.
 *
 * A short LIST per owner (normalized "0.0.x" account id, 24h TTL) — a
 * proposal the human never taps simply expires; nothing is ever executed
 * without the tap. New proposals are APPENDED; when the list is full the
 * stash throws PendingActionConflictError instead of silently replacing an
 * older proposal — the agent is told to point the human at their Buddy
 * chat rather than dropping work on the floor.
 *
 * The inbox holds REFERENCES, not transactions: a claim entry points at a
 * claim package (lib/server/claim-packages.ts); an update entry carries the
 * proposed page spec. Pinning and building the frozen transaction happen at
 * APPROVE time (POST /api/claim-packages/[id]/finalize for claims,
 * POST /api/agents/page-updates/[id]/finalize for updates) with the
 * actually connected wallet as payer — whoever taps owns it.
 *
 * Never stores keys, never signs: signing happens in the user's wallet via
 * the DAppConnector pairing.
 */
import { randomBytes } from "node:crypto";
import { ethers } from "ethers";
import { getKvStore, type KvStore } from "./store";
import type { ClaimPageSpec } from "./page-customize";

/** Proposal kinds the inbox can hold. */
export type PendingActionKind =
  | "agent-claim"
  | "agent-page-update"
  | "purchase"
  | "hire-review";

/** Purchase details stashed for a "purchase" pending action. */
export interface PurchaseProposalDetails {
  /** Marketplace listing id. */
  listingId: string;
  /** Listing title shown on the approval card. */
  title: string;
  /** Seller display (username or address). */
  seller: string;
  /** Seller EVM address for the buyListing call. */
  sellerEvm: string;
  /** Tips contract id "0.0.x" receiving the call. */
  contractId: string;
  /** Price in USD cents (listing's listed price). */
  priceUsdCents: number;
  /** Payable value in tinybar for the buyListing call. */
  valueTinybar: string;
  /** Same value in HBAR for the card. */
  valueHbar: string;
  /** Capability token id that submitted it (audit trail). */
  tokenId: string;
}

/** Hire-review details stashed for a "hire-review" pending action. */
export interface HireReviewProposalDetails {
  /** Reviewing agent's username. */
  reviewerUsername: string;
  /** Reviewing agent's owner EVM address. */
  reviewerEvm: string;
  /** Reviewed page's username. */
  targetUsername: string;
  /** Reviewed page's owner EVM address. */
  targetEvm: string;
  /** 1-5 stars. */
  rating: number;
  /** Review text (may be empty). */
  text: string;
  /** Proof-of-payment transaction id backing the review. */
  proofTxId: string;
  /** Kind of the proven payment ("tip" | "purchase"). */
  proofKind: "tip" | "purchase";
  /** Capability token id that submitted it (audit trail). */
  tokenId: string;
}

/**
 * Manifest class for a page-update proposal (adopted from the receipts
 * thread). The proposal declares what the signed tap covers:
 * - static: content fully visible at approve time — "see exactly what
 *   you're about to publish" covers these.
 * - immutableRefs: hash-addressed refs (ipfs://, data: URIs, bare CIDs).
 *   Fetch, hash, compare at audit — a violation is provable.
 * - mutableRefs: plain URLs (socials, links). Only the DECLARED SET is
 *   checkable; content drift behind these URLs is undecidable at audit
 *   time. Bound as a declaration, not a commitment — the code and docs
 *   must say so, not imply otherwise.
 */
export interface ProposalManifest {
  static: {
    displayName: string;
    purpose: string;
    capabilities: string[];
    theme: string | null;
    templateId: string | null;
  };
  immutableRefs: string[];
  mutableRefs: string[];
}

/**
 * Classify a ref URL as immutable (hash-addressed) or mutable (plain URL).
 * Immutable: ipfs://…, data:…, or a bare CID (Qm… / bafy… / bafk…).
 * Everything else — https:// socials, link URLs — is mutable: the declared
 * set is checkable, the content behind it is not.
 */
export function classifyRef(url: string): "immutable" | "mutable" {
  const u = (url ?? "").trim();
  const lower = u.toLowerCase();
  if (lower.startsWith("ipfs://") || lower.startsWith("data:")) return "immutable";
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(u)) return "immutable";
  if (/^bafy[a-z2-7]+$/.test(lower) || /^bafk[a-z2-7]+$/.test(lower)) return "immutable";
  return "mutable";
}

/** Build the manifest class for a proposal spec. */
export function buildProposalManifest(spec: ClaimPageSpec): ProposalManifest {
  const urls: string[] = [];
  for (const s of spec.socials ?? []) {
    if (s && typeof s.url === "string" && s.url.trim()) urls.push(s.url.trim());
  }
  for (const l of spec.links ?? []) {
    if (l && typeof l.url === "string" && l.url.trim()) urls.push(l.url.trim());
  }
  const immutableRefs: string[] = [];
  const mutableRefs: string[] = [];
  for (const u of urls) {
    (classifyRef(u) === "immutable" ? immutableRefs : mutableRefs).push(u);
  }
  return {
    static: {
      displayName: spec.displayName ?? "",
      purpose: spec.purpose ?? "",
      capabilities: Array.isArray(spec.capabilities) ? [...spec.capabilities] : [],
      theme: spec.theme ? JSON.stringify(spec.theme) : null,
      templateId: spec.templateId ?? null,
    },
    immutableRefs: [...new Set(immutableRefs)].sort(),
    mutableRefs: [...new Set(mutableRefs)].sort(),
  };
}

/**
 * Deterministic canonicalization: object keys sorted recursively, arrays
 * keep order. Same logical proposal → same string, always.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(rec[k])}`).join(",")}}`;
  }
  return "null";
}

/**
 * Content digest for a page-update proposal.
 *
 * Construction (named, per the receipts thread): keccak256 of the raw
 * UTF-8 canonical message — the same construction empirically confirmed
 * for release_reservation's digest. Covers the static content + immutable
 * refs; the mutable ref set is bound as a declaration (see ProposalManifest),
 * not inside the digest.
 *
 * The approval record links this digest, so the human's signed tap becomes
 * checkable evidence a stranger can re-verify: recompute from the proposal,
 * compare, done. The proposal declares; the human signs; anyone verifies.
 */
export function proposalDigest(spec: ClaimPageSpec, manifest?: ProposalManifest): string {
  const m = manifest ?? buildProposalManifest(spec);
  const message = canonicalize({
    v: "voicescape:proposal-digest:v1",
    static: m.static,
    immutableRefs: m.immutableRefs,
  });
  return ethers.keccak256(ethers.toUtf8Bytes(message));
}

export interface PageUpdateProposalDetails {
  /**
   * The proposed new page content. Assembled + pinned to IPFS at APPROVE
   * time (pinning at propose time orphans a page every untapped proposal).
   */
  spec: ClaimPageSpec;
  /** Human-readable description of what changed — the agent's own words. */
  changeSummary: string;
  /** Capability token id that submitted it (audit trail). */
  tokenId: string;
  /**
   * keccak256 of the raw UTF-8 canonical proposal message (static content
   * + immutable refs). Computed at stash time; the approval record links
   * it so the signed tap is checkable evidence, not a policy assertion.
   */
  digest: string;
  /** Manifest class: what the digest covers vs what's bound as declaration. */
  manifest: ProposalManifest;
}

export interface PendingAction {
  id: string;
  kind: PendingActionKind;
  createdAt: number;
  /** Normalized "0.0.x" owner account id. */
  ownerAccountId: string;
  /** Short card label, e.g. "Agent blockpage claim". */
  label: string;
  /** Card title, e.g. "Register @thechomps" / "Update @thechomps". */
  title: string;
  /** Plain-words summary of what the signature does (from what_youre_signing). */
  summary: string;
  /** Cost copy, e.g. "Network gas only — a few cents of HBAR." */
  costEstimate: string;
  /** Claim-package short id — agent-claim only, finalized at approve time. */
  claimPackageId?: string;
  /** Update details — agent-page-update only, pinned at approve time. */
  pageUpdate?: PageUpdateProposalDetails;
  /** Purchase details — purchase only; the buyer signs buyListing at tap time. */
  purchase?: PurchaseProposalDetails;
  /** Review details — hire-review only; posted server-side at tap time. */
  hireReview?: HireReviewProposalDetails;
}

/** Thrown when the owner's inbox is full — nothing is overwritten. */
export class PendingActionConflictError extends Error {}

const KEY_PREFIX = "pending-actions:";
const TTL_MS = 24 * 3_600_000;
/**
 * Global id → owner index so a proposal can be found from a public approval
 * link (/p/<id>) without knowing the owner up front. The id is unguessable
 * (16 hex chars); the index carries no proposal content, just the owner key.
 * Written at stash time, removed when the proposal is cleared.
 */
const ID_INDEX_PREFIX = "pending-action-by-id:";

function idIndexKey(id: string): string {
  return `${ID_INDEX_PREFIX}${id}`;
}
/** Max unexpired proposals per owner before new ones conflict. */
export const MAX_PENDING_PER_OWNER = 3;

function keyFor(ownerAccountId: string): string {
  return `${KEY_PREFIX}${ownerAccountId.trim()}`;
}

export interface StashPendingActionInput {
  claimPackageId: string;
  username: string;
  owner_account_id: string;
  what_youre_signing: string;
}

async function readList(owner: string, store: KvStore): Promise<PendingAction[]> {
  const raw = await store.get(keyFor(owner));
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as PendingAction[];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (p) =>
        p &&
        typeof p.id === "string" &&
        (p.kind === "agent-claim"
          ? typeof p.claimPackageId === "string"
          : p.kind === "agent-page-update"
            ? p.pageUpdate && typeof p.pageUpdate === "object"
            : p.kind === "purchase"
              ? p.purchase && typeof p.purchase === "object"
              : p.kind === "hire-review"
                ? p.hireReview && typeof p.hireReview === "object"
                : false),
    );
  } catch {
    return [];
  }
}

/** A single proposal by id, or null. */
export async function getPendingActionById(
  ownerAccountId: string,
  id: string,
  store: KvStore = getKvStore(),
): Promise<PendingAction | null> {
  const list = await readList(ownerAccountId.trim(), store);
  return list.find((p) => p.id === id) ?? null;
}

/**
 * Find a proposal from its public approval-link id (/p/<id>) without
 * knowing the owner. Returns null for unknown/malformed ids. The index
 * holds only the owner pointer — the proposal itself is re-read from the
 * owner's inbox so a stale index can never resurrect cleared content.
 */
export async function getPendingActionByPublicId(
  id: string,
  store: KvStore = getKvStore(),
): Promise<PendingAction | null> {
  const clean = (id ?? "").trim();
  if (!/^[0-9a-f]{16}$/.test(clean)) return null;
  const owner = await store.get(idIndexKey(clean));
  if (!owner || !/^\d+\.\d+\.\d+$/.test(owner)) return null;
  return getPendingActionById(owner, clean, store);
}

/**
 * Append a freshly prepared claim as the owner's pending action. Throws
 * PendingActionConflictError when the inbox already holds
 * MAX_PENDING_PER_OWNER unexpired proposals (caller surfaces this to the
 * agent instead of silently dropping the older ones); throws on invalid
 * input. KV failures propagate. `store` is injectable for tests.
 */
export async function stashPendingAction(
  input: StashPendingActionInput,
  store: KvStore = getKvStore(),
): Promise<PendingAction> {
  const owner = (input.owner_account_id ?? "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(owner)) {
    throw new Error("stashPendingAction: bad owner account id");
  }
  const claimPackageId = (input.claimPackageId ?? "").trim();
  if (!/^[0-9a-f]{32}$/.test(claimPackageId)) {
    throw new Error("stashPendingAction: bad claim package id");
  }
  const username = (input.username ?? "").trim().toLowerCase();
  if (!username) throw new Error("stashPendingAction: missing username");
  const summary = (input.what_youre_signing ?? "").trim();
  if (!summary) throw new Error("stashPendingAction: missing summary");

  const list = await readList(owner, store);
  if (list.length >= MAX_PENDING_PER_OWNER) {
    throw new PendingActionConflictError(
      `owner ${owner} already has ${list.length} pending proposals — ask the human to check their Buddy chat before preparing another`,
    );
  }
  const action: PendingAction = {
    id: randomBytes(8).toString("hex"),
    kind: "agent-claim",
    createdAt: Date.now(),
    ownerAccountId: owner,
    label: "Agent blockpage claim",
    title: `Register @${username}`,
    summary,
    costEstimate: "Network gas only — a few cents of HBAR. No fee to Voicescape.",
    claimPackageId,
  };
  list.push(action);
  await store.set(keyFor(owner), JSON.stringify(list), TTL_MS);
  return action;
}

/** The owner's pending actions (0..MAX), oldest first. Empty when none. */
export async function getPendingActions(
  ownerAccountId: string,
  store: KvStore = getKvStore(),
): Promise<PendingAction[]> {
  return readList(ownerAccountId.trim(), store);
}

export interface StashPageUpdateInput {
  owner_account_id: string;
  /** Proposed new page content (assembled + pinned at approve time). */
  spec: ClaimPageSpec;
  /** Human-readable description of what changed — shown on the card. */
  change_summary: string;
  /** Capability token id that submitted it (audit trail). */
  token_id: string;
}

/**
 * Append a keyless-agent page-update proposal as the owner's pending
 * action. Same inbox rules as claims: max MAX_PENDING_PER_OWNER, 24h TTL,
 * nothing executes without the human's tap. The page is NOT pinned here —
 * pinning happens at approve time, so untapped proposals orphan nothing.
 * Throws PendingActionConflictError when the inbox is full; throws on
 * invalid input. KV failures propagate. `store` is injectable for tests.
 */
export async function stashPageUpdateProposal(
  input: StashPageUpdateInput,
  store: KvStore = getKvStore(),
): Promise<PendingAction> {
  const owner = (input.owner_account_id ?? "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(owner)) {
    throw new Error("stashPageUpdateProposal: bad owner account id");
  }
  const spec = input.spec;
  if (!spec || typeof spec !== "object") throw new Error("stashPageUpdateProposal: missing spec");
  const username = (spec.username ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
    throw new Error("stashPageUpdateProposal: bad username in spec");
  }
  const changeSummary = (input.change_summary ?? "").trim().slice(0, 500);
  if (!changeSummary) throw new Error("stashPageUpdateProposal: missing change summary");
  const tokenId = (input.token_id ?? "").trim();
  if (!/^[0-9a-f]{16}$/.test(tokenId)) {
    throw new Error("stashPageUpdateProposal: bad token id");
  }

  const list = await readList(owner, store);
  if (list.length >= MAX_PENDING_PER_OWNER) {
    throw new PendingActionConflictError(
      `owner ${owner} already has ${list.length} pending proposals — ask the human to check their Buddy chat before preparing another`,
    );
  }
  const manifest = buildProposalManifest({ ...spec, username });
  const digest = proposalDigest({ ...spec, username }, manifest);
  const action: PendingAction = {
    id: randomBytes(8).toString("hex"),
    kind: "agent-page-update",
    createdAt: Date.now(),
    ownerAccountId: owner,
    label: "Agent page update",
    title: `Update @${username}`,
    summary: changeSummary,
    costEstimate: "Network gas only — a few cents of HBAR. No fee to Voicescape.",
    pageUpdate: {
      spec: { ...spec, username },
      changeSummary,
      tokenId,
      manifest,
      digest,
    },
  };
  list.push(action);
  await store.set(keyFor(owner), JSON.stringify(list), TTL_MS);
  await store.set(idIndexKey(action.id), owner, TTL_MS);
  return action;
}

export interface StashPurchaseInput {
  owner_account_id: string;
  /** Listing + buy params — snapshotted so the card can't drift. */
  purchase: Omit<PurchaseProposalDetails, "tokenId">;
  /** Capability token id that submitted it (audit trail). */
  token_id: string;
}

/**
 * Append a purchase-approval request as the owner's pending action. Same
 * inbox rules as claims/updates: max MAX_PENDING_PER_OWNER, 24h TTL,
 * nothing executes without the human's tap. The buyListing call data is
 * already fully determined (seller, listing ref, value) — at tap time the
 * human's own wallet signs it; the server never signs and never submits.
 * Throws PendingActionConflictError when the inbox is full; throws on
 * invalid input. KV failures propagate. `store` is injectable for tests.
 */
export async function stashPurchaseProposal(
  input: StashPurchaseInput,
  store: KvStore = getKvStore(),
): Promise<PendingAction> {
  const owner = (input.owner_account_id ?? "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(owner)) {
    throw new Error("stashPurchaseProposal: bad owner account id");
  }
  const p = input.purchase;
  if (!p || typeof p !== "object") throw new Error("stashPurchaseProposal: missing purchase");
  const listingId = (p.listingId ?? "").toString().trim();
  if (!listingId) throw new Error("stashPurchaseProposal: missing listing id");
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.sellerEvm ?? "")) {
    throw new Error("stashPurchaseProposal: bad seller EVM address");
  }
  if (!/^\d+$/.test((p.valueTinybar ?? "").toString()) || BigInt(p.valueTinybar as string) <= 0n) {
    throw new Error("stashPurchaseProposal: bad payable value");
  }
  const tokenId = (input.token_id ?? "").trim();
  if (!/^[0-9a-f]{16}$/.test(tokenId)) {
    throw new Error("stashPurchaseProposal: bad token id");
  }

  const list = await readList(owner, store);
  if (list.length >= MAX_PENDING_PER_OWNER) {
    throw new PendingActionConflictError(
      `owner ${owner} already has ${list.length} pending proposals — ask the human to check their Buddy chat before preparing another`,
    );
  }
  const action: PendingAction = {
    id: randomBytes(8).toString("hex"),
    kind: "purchase",
    createdAt: Date.now(),
    ownerAccountId: owner,
    label: "Marketplace purchase",
    title: `Buy "${p.title}"`,
    summary: `Buy "${p.title}" from ${p.seller} for ${p.valueHbar} HBAR. The Tips contract splits it 98% to the seller and 2% to the platform, atomically — no escrow, no custody.`,
    costEstimate: `${p.valueHbar} HBAR for the item plus a few cents of HBAR network gas. No fee to Voicescape beyond the on-chain 2%.`,
    purchase: { ...p, listingId, tokenId },
  };
  list.push(action);
  await store.set(keyFor(owner), JSON.stringify(list), TTL_MS);
  await store.set(idIndexKey(action.id), owner, TTL_MS);
  return action;
}

export interface StashReviewInput {
  owner_account_id: string;
  /** Review content — validated; the proof tx is verified, NOT claimed, here. */
  review: Omit<HireReviewProposalDetails, "tokenId">;
  /** Capability token id that submitted it (audit trail). */
  token_id: string;
}

/**
 * Append a hire-review approval request as the owner's pending action.
 * Same inbox rules: max MAX_PENDING_PER_OWNER, 24h TTL, nothing posts
 * without the human's tap. The proof-of-payment tx is verified at request
 * time but only CLAIMED at approve time — an untapped request never burns
 * the proof. Throws PendingActionConflictError when the inbox is full;
 * throws on invalid input. KV failures propagate. `store` is injectable
 * for tests.
 */
export async function stashReviewProposal(
  input: StashReviewInput,
  store: KvStore = getKvStore(),
): Promise<PendingAction> {
  const owner = (input.owner_account_id ?? "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(owner)) {
    throw new Error("stashReviewProposal: bad owner account id");
  }
  const r = input.review;
  if (!r || typeof r !== "object") throw new Error("stashReviewProposal: missing review");
  const reviewerUsername = (r.reviewerUsername ?? "").toString().trim().toLowerCase();
  const targetUsername = (r.targetUsername ?? "").toString().trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,32}$/.test(reviewerUsername)) {
    throw new Error("stashReviewProposal: bad reviewer username");
  }
  if (!/^[a-z0-9_-]{3,32}$/.test(targetUsername)) {
    throw new Error("stashReviewProposal: bad target username");
  }
  if (reviewerUsername === targetUsername) {
    throw new Error("stashReviewProposal: cannot review your own page");
  }
  if (!Number.isInteger(r.rating) || r.rating < 1 || r.rating > 5) {
    throw new Error("stashReviewProposal: rating must be 1-5");
  }
  if (r.proofKind !== "tip" && r.proofKind !== "purchase") {
    throw new Error("stashReviewProposal: bad proof kind");
  }
  const text = (r.text ?? "").toString().slice(0, 2000);
  const proofTxId = (r.proofTxId ?? "").toString().trim();
  if (!proofTxId) throw new Error("stashReviewProposal: missing proof transaction");
  const tokenId = (input.token_id ?? "").trim();
  if (!/^[0-9a-f]{16}$/.test(tokenId)) {
    throw new Error("stashReviewProposal: bad token id");
  }

  const list = await readList(owner, store);
  if (list.length >= MAX_PENDING_PER_OWNER) {
    throw new PendingActionConflictError(
      `owner ${owner} already has ${list.length} pending proposals — ask the human to check their Buddy chat before preparing another`,
    );
  }
  const action: PendingAction = {
    id: randomBytes(8).toString("hex"),
    kind: "hire-review",
    createdAt: Date.now(),
    ownerAccountId: owner,
    label: "Hire review",
    title: `Review @${targetUsername}`,
    summary: `@${reviewerUsername} rates @${targetUsername} ${r.rating}/5, backed by on-chain payment ${proofTxId}.`,
    costEstimate: "Posting the review costs nothing — the proof payment is already settled on-chain.",
    hireReview: {
      reviewerUsername,
      reviewerEvm: (r.reviewerEvm ?? "").toString().toLowerCase(),
      targetUsername,
      targetEvm: (r.targetEvm ?? "").toString().toLowerCase(),
      rating: r.rating,
      text,
      proofTxId,
      proofKind: r.proofKind,
      tokenId,
    },
  };
  list.push(action);
  await store.set(keyFor(owner), JSON.stringify(list), TTL_MS);
  await store.set(idIndexKey(action.id), owner, TTL_MS);
  return action;
}

/**
 * Clear the owner's inbox — after approval, rejection-by-expiry, or
 * dismiss. Pass `id` to clear a single proposal, omit to clear all.
 */
export async function clearPendingAction(
  ownerAccountId: string,
  id?: string,
  store: KvStore = getKvStore(),
): Promise<void> {
  const owner = ownerAccountId.trim();
  if (!id) {
    const list = await readList(owner, store);
    for (const p of list) {
      if (p && typeof p.id === "string") await store.del(idIndexKey(p.id));
    }
    await store.del(keyFor(owner));
    return;
  }
  const list = await readList(owner, store);
  const rest = list.filter((p) => p.id !== id);
  await store.del(idIndexKey(id));
  if (rest.length === 0) {
    await store.del(keyFor(owner));
  } else {
    await store.set(keyFor(owner), JSON.stringify(rest), TTL_MS);
  }
}
