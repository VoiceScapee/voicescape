/**
 * page-updates — client helpers for keyless-agent page-update proposals.
 *
 * The human taps Approve on a one-tap card in chat. This finalizes the
 * proposal: the server pins the proposed page and builds the frozen
 * unsigned updatePage transaction with the human's account as payer —
 * then the human signs once in their wallet via submitPreparedTx.
 *
 * The finalize route is session-authenticated (x-vs-session); callers pass
 * the session header like the proposals inbox does.
 */
import type { PendingAction } from "@/lib/server/pending-actions";

export interface FinalizedPageUpdate extends PendingAction {
  unsignedTxBytes: string;
  transactionId: string;
  signerAccountId: string;
  cid: string;
}

export class PageUpdateError extends Error {}

/**
 * Finalize an update proposal for the signed-in owner: pins the proposed
 * page and builds the frozen updatePage transaction. Throws
 * PageUpdateError with the server's honest message.
 */
export async function finalizePageUpdate(
  id: string,
  sessionHeaders: Record<string, string>,
): Promise<FinalizedPageUpdate> {
  let res: Response;
  try {
    res = await fetch(`/api/agents/page-updates/${encodeURIComponent(id)}/finalize`, {
      method: "POST",
      headers: { ...sessionHeaders, "Content-Type": "application/json" },
    });
  } catch {
    throw new PageUpdateError("Couldn't reach Voicescape — check your connection and retry.");
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new PageUpdateError(
      typeof body?.error === "string" && body.error
        ? body.error
        : "Couldn't prepare the update — try again in a moment.",
    );
  }
  const b = body as unknown as {
    username: string;
    owner_account_id: string;
    unsignedTxBytes: string;
    transactionId: string;
    signerAccountId: string;
    cid: string;
    label: string;
    title: string;
    summary: string;
    costEstimate: string;
  };
  return {
    id,
    kind: "agent-page-update",
    createdAt: Date.now(),
    ownerAccountId: b.owner_account_id,
    label: b.label,
    title: b.title,
    summary: b.summary,
    costEstimate: b.costEstimate,
    unsignedTxBytes: b.unsignedTxBytes,
    transactionId: b.transactionId,
    signerAccountId: b.signerAccountId,
    cid: b.cid,
  };
}
