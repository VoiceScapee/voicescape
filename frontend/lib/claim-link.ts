/**
 * claim-link — client helpers for the short approval link (/c/<id>).
 *
 * The human opens the link their agent dropped in its own chat. Pairing
 * (DAppConnector) is the only auth — no 7-day session needed. The flow:
 * fetch the package summary → review → tap Approve → finalize (server pins
 * the page + builds the frozen tx with the paired wallet as payer) →
 * submitPreparedTx → auto-link the intro.
 */
import type { PendingAction } from "@/lib/server/pending-actions";

export interface ClaimSummary {
  username: string;
  purpose: string;
  display_name: string;
  capabilities: string[];
  owner_account_id: string | null;
  claim_code: string | null;
  page_url: string;
  owner_type: "human" | "agent";
  /** "sovereign" = human signs on this page; "self" = agent signs with its own key (read-only here). */
  mode: "sovereign" | "self";
  created_at: string;
}

export interface FinalizedClaim extends PendingAction {
  unsignedTxBytes: string;
  transactionId: string;
  signerAccountId: string;
  intro_claim_code: string | null;
  owner_funded: boolean | null;
  cid: string;
  page_url: string;
}

export class ClaimLinkError extends Error {}

/** Read the public summary for a short id. Throws ClaimLinkError when invalid/expired. */
export async function fetchClaimSummary(id: string): Promise<ClaimSummary> {
  let res: Response;
  try {
    res = await fetch(`/api/claim-packages/${encodeURIComponent(id)}`, { cache: "no-store" });
  } catch {
    throw new ClaimLinkError("Couldn't reach Voicescape — check your connection and retry.");
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new ClaimLinkError(
      typeof body?.error === "string" && body.error
        ? body.error
        : "This approval link is invalid or expired — ask your agent for a fresh one.",
    );
  }
  return body as unknown as ClaimSummary;
}

/**
 * Fetch the assembled (not yet pinned) page document for a short id, so
 * the approve page can render a true preview of the custom layout before
 * the human signs. Best-effort: returns null when the preview can't be
 * assembled — the text summary above still lets the human decide.
 */
export async function fetchClaimPreview(id: string): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await fetch(`/api/claim-packages/${encodeURIComponent(id)}/preview`, { cache: "no-store" });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { page?: Record<string, unknown> } | null;
  return body && typeof body.page === "object" && body.page !== null ? body.page : null;
}

/**
 * Finalize a package for the paired wallet: pins the starter page (once)
 * and builds the frozen registerPage transaction with `accountId` as
 * payer. Throws ClaimLinkError with the server's honest message.
 */
export async function finalizeClaimPackage(
  id: string,
  accountId: string,
): Promise<FinalizedClaim> {
  let res: Response;
  try {
    res = await fetch(`/api/claim-packages/${encodeURIComponent(id)}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: accountId }),
    });
  } catch {
    throw new ClaimLinkError("Couldn't reach Voicescape — check your connection and retry.");
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new ClaimLinkError(
      typeof body?.error === "string" && body.error
        ? body.error
        : "Couldn't prepare the transaction — try again in a moment.",
    );
  }
  const b = body as unknown as {
    username: string;
    owner_account_id: string;
    unsignedTxBytes: string;
    transactionId: string;
    signerAccountId: string;
    label: string;
    title: string;
    summary: string;
    costEstimate: string;
    intro_claim_code: string | null;
    owner_funded: boolean | null;
    cid: string;
    page_url: string;
  };
  return {
    id,
    kind: "agent-claim",
    createdAt: Date.now(),
    ownerAccountId: b.owner_account_id,
    label: b.label,
    title: b.title,
    summary: b.summary,
    costEstimate: b.costEstimate,
    claimPackageId: id,
    unsignedTxBytes: b.unsignedTxBytes,
    transactionId: b.transactionId,
    signerAccountId: b.signerAccountId,
    intro_claim_code: b.intro_claim_code,
    owner_funded: b.owner_funded,
    cid: b.cid,
    page_url: b.page_url,
  };
}

/**
 * Best-effort: after on-chain confirmation, link the agent's intro using
 * the package short id as authorization (no session needed). Never throws —
 * the agent can always link it later by hand.
 */
export async function linkIntroAfterClaim(
  packageId: string,
  claimCode: string,
): Promise<boolean> {
  try {
    const res = await fetch("/api/intros/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claim_code: claimCode, package_id: packageId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Best-effort: after the wallet's signature confirms on-chain, tell the
 * server the claim completed so the agent polling the package status sees
 * "completed" (with the live page URL) instead of waiting on "awaiting_signature"
 * forever. The server verifies the transaction on the mirror node before
 * marking it — the client's word alone isn't enough. Never throws.
 */
export async function reportClaimCompleted(
  packageId: string,
  transactionId: string,
): Promise<boolean> {
  try {
    const res = await fetch(`/api/claim-packages/${encodeURIComponent(packageId)}/completed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction_id: transactionId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
