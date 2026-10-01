/**
 * pending-actions — the KV-backed inbox of agent-initiated on-chain actions
 * awaiting the owner's one-tap approval in the Buddy chat.
 *
 * One slot per owner (normalized to the "0.0.x" account id), 24h TTL — a
 * proposal the human never taps simply expires; nothing is ever executed
 * without the tap. The agent's preparation step (MCP prepare_agent_claim)
 * stashes here best-effort; the chat widget polls and renders each pending
 * action as an inline approval card in the thread. The human's only action
 * is the Approve tap — the agent/frontend does everything else.
 *
 * Never stores keys, never signs: the payload is the frozen UNSIGNED tx
 * bytes; signing happens in the user's wallet via the DAppConnector pairing.
 */
import { randomBytes } from "node:crypto";
import { getKvStore, type KvStore } from "./store";
import type { AgentClaimPackage } from "./mcp-tools";

export interface PreparedTxPayloadWire {
  transactionList: string;
  signerAccountId: string;
  transactionId: string;
}

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
  payload: PreparedTxPayloadWire;
}

const KEY_PREFIX = "pending-action:";
const TTL_MS = 24 * 3_600_000;

function keyFor(ownerAccountId: string): string {
  return `${KEY_PREFIX}${ownerAccountId.trim()}`;
}

function isAgentClaimPackage(p: unknown): p is AgentClaimPackage {
  if (!p || typeof p !== "object") return false;
  const v = p as Record<string, unknown>;
  return (
    typeof v.username === "string" &&
    typeof v.owner_account_id === "string" &&
    typeof v.unsignedTxBytes === "string" &&
    typeof v.what_youre_signing === "string" &&
    typeof v.transactionId === "string"
  );
}

/**
 * Stash a freshly prepared claim package as the owner's pending action,
 * replacing any older one. Throws on invalid input (caller treats as
 * best-effort); KV failures propagate the same way. `store` is injectable
 * for tests.
 */
export async function stashPendingAction(
  pkg: unknown,
  store: KvStore = getKvStore(),
): Promise<PendingAction> {
  if (!isAgentClaimPackage(pkg)) {
    throw new Error("stashPendingAction: not an agent claim package");
  }
  const owner = pkg.owner_account_id.trim();
  if (!/^\d+\.\d+\.\d+$/.test(owner)) {
    throw new Error("stashPendingAction: bad owner account id");
  }
  const action: PendingAction = {
    id: randomBytes(8).toString("hex"),
    kind: "agent-claim",
    createdAt: Date.now(),
    ownerAccountId: owner,
    label: "Agent blockpage claim",
    title: `Register @${pkg.username}`,
    summary: pkg.what_youre_signing,
    costEstimate: "Network gas only — a few cents of HBAR. No fee to Voicescape.",
    payload: {
      transactionList: pkg.unsignedTxBytes,
      signerAccountId: `hedera:mainnet:${owner}`,
      transactionId: pkg.transactionId,
    },
  };
  await store.set(keyFor(owner), JSON.stringify(action), TTL_MS);
  return action;
}

/** The owner's pending action, or null when the inbox is empty/expired. */
export async function getPendingAction(
  ownerAccountId: string,
  store: KvStore = getKvStore(),
): Promise<PendingAction | null> {
  const raw = await store.get(keyFor(ownerAccountId));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PendingAction;
    return p && typeof p.id === "string" && p.payload ? p : null;
  } catch {
    return null;
  }
}

/** Clear the owner's slot — after approval, rejection-by-expiry, or dismiss. */
export async function clearPendingAction(
  ownerAccountId: string,
  store: KvStore = getKvStore(),
): Promise<void> {
  await store.del(keyFor(ownerAccountId));
}
