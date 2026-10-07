/**
 * update-link — client helpers for the proposal approval link (/p/<id>).
 *
 * The agent drops the /p/<id> link in its OWN chat. Pairing
 * (DAppConnector) is the only auth — no 7-day session needed. The flow:
 * fetch the proposal summary → review → tap Approve → finalize (server
 * pins the proposed page + builds the frozen updatePage tx with the paired
 * wallet as payer; the paired wallet MUST own the page) →
 * submitPreparedTx → done.
 */
import type { PendingAction } from "@/lib/server/pending-actions";

export interface UpdateSummary {
  proposal_id: string;
  username: string;
  change_summary: string;
  display_name: string;
  purpose: string;
  owner_account_id: string;
  cost_estimate: string;
  created_at: string;
  expires_at: string;
}

export interface FinalizedUpdate extends PendingAction {
  unsignedTxBytes: string;
  transactionId: string;
  signerAccountId: string;
  /** Normalized "0.0.x" owner — the wallet that must sign. */
  owner_account_id: string;
  cid: string;
  note: string;
}

export class UpdateLinkError extends Error {}

/** Read the public summary for a proposal id. Throws UpdateLinkError when invalid/expired. */
export async function fetchUpdateSummary(id: string): Promise<UpdateSummary> {
  let res: Response;
  try {
    res = await fetch(`/api/page-updates/${encodeURIComponent(id)}`, { cache: "no-store" });
  } catch {
    throw new UpdateLinkError("Couldn't reach Voicescape — check your connection and retry.");
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new UpdateLinkError(
      typeof body?.error === "string" && body.error
        ? body.error
        : "This approval link is invalid or expired — ask your agent for a fresh proposal.",
    );
  }
  return body as unknown as UpdateSummary;
}

/**
 * Finalize a proposal for the paired wallet: pins the proposed page and
 * builds the frozen updatePage transaction with `accountId` as payer.
 * The server rejects any account that doesn't own the page. Throws
 * UpdateLinkError with the server's honest message.
 */
export async function finalizeUpdateProposal(
  id: string,
  accountId: string,
): Promise<FinalizedUpdate> {
  let res: Response;
  try {
    res = await fetch(`/api/page-updates/${encodeURIComponent(id)}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: accountId }),
    });
  } catch {
    throw new UpdateLinkError("Couldn't reach Voicescape — check your connection and retry.");
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new UpdateLinkError(
      typeof body?.error === "string" && body.error
        ? body.error
        : "Couldn't prepare the transaction — try again in a moment.",
    );
  }
  return body as unknown as FinalizedUpdate;
}
