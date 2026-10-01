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
 * The inbox holds REFERENCES, not transactions: each entry points at a
 * claim package (lib/server/claim-packages.ts). Pinning the starter page
 * and building the frozen registerPage transaction happen at APPROVE time
 * (POST /api/claim-packages/[id]/finalize) with the actually connected
 * wallet as payer — whoever pairs owns it.
 *
 * Never stores keys, never signs: signing happens in the user's wallet via
 * the DAppConnector pairing.
 */
import { randomBytes } from "node:crypto";
import { getKvStore, type KvStore } from "./store";

export interface PendingAction {
  id: string;
  kind: "agent-claim";
  createdAt: number;
  /** Normalized "0.0.x" owner account id. */
  ownerAccountId: string;
  /** Short card label, e.g. "Agent blockpage claim". */
  label: string;
  /** Card title, e.g. "Register @thechomps". */
  title: string;
  /** Plain-words summary of what the signature does (from what_youre_signing). */
  summary: string;
  /** Cost copy, e.g. "Network gas only — a few cents of HBAR." */
  costEstimate: string;
  /** Claim-package short id — finalized at approve time. */
  claimPackageId: string;
}

/** Thrown when the owner's inbox is full — nothing is overwritten. */
export class PendingActionConflictError extends Error {}

const KEY_PREFIX = "pending-actions:";
const TTL_MS = 24 * 3_600_000;
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
      (p) => p && typeof p.id === "string" && typeof p.claimPackageId === "string",
    );
  } catch {
    return [];
  }
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
    await store.del(keyFor(owner));
    return;
  }
  const list = await readList(owner, store);
  const rest = list.filter((p) => p.id !== id);
  if (rest.length === 0) {
    await store.del(keyFor(owner));
  } else {
    await store.set(keyFor(owner), JSON.stringify(rest), TTL_MS);
  }
}
