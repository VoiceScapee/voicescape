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
import { getKvStore, type KvStore } from "./store";
import type { ClaimPageSpec } from "./page-customize";

/** Proposal kinds the inbox can hold. */
export type PendingActionKind = "agent-claim" | "agent-page-update";

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
          : p.kind === "agent-page-update" && p.pageUpdate && typeof p.pageUpdate === "object"),
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
