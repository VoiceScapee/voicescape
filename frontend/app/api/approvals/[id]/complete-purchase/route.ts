/**
 * POST /api/approvals/[id]/complete-purchase — human's wallet signed the
 * buyListing call from a purchase approval link (/p/<id>); clear the
 * pending approval.
 *
 * Body: { account_id: "0.0.x", tx_id: "0.0.x@seconds.nanos" } — the wallet
 * the human paired on the approval page and the id of the buyListing
 * transaction their wallet submitted. Auth: none beyond the unguessable
 * approval id — the paired account MUST equal the approval's owner (the
 * human who issued the agent's capability token); anything else is
 * rejected.
 *
 * The server never sees or validates the purchase itself here: the Tips
 * contract enforced the 98/2 split atomically on-chain, and the response
 * hands back the HashScan link so the human verifies it themselves.
 * Rate-limited per IP. Never touches keys; never signs.
 */
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import {
  getPendingActionByPublicId,
  clearPendingAction,
} from "@/lib/server/pending-actions";
import { toMirrorTxId } from "@/lib/prepared-tx";
import { ipGate } from "@/lib/server/rate-limit";

const PROPOSAL_MAX_AGE_MS = 24 * 3_600_000;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await ipGate(
    req,
    "approval-complete-purchase",
    "APPROVAL_COMPLETE_PURCHASE_IP_LIMIT",
    20,
    "too many approval attempts — try again in a bit",
  );
  if (gated) return gated;

  let accountId = "";
  let txId = "";
  try {
    const body = (await req.json()) as { account_id?: unknown; tx_id?: unknown };
    accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
    txId = typeof body.tx_id === "string" ? body.tx_id.trim() : "";
  } catch {
    return NextResponse.json({ error: "body must be JSON with account_id and tx_id" }, { status: 400 });
  }
  if (!/^\d+\.\d+\.\d+$/.test(accountId)) {
    return NextResponse.json({ error: "account_id must be a 0.0.x Hedera account" }, { status: 400 });
  }
  if (!/^\d+\.\d+\.\d+@\d+\.\d+$/.test(txId)) {
    return NextResponse.json({ error: "tx_id must be a Hedera transaction id (0.0.x@seconds.nanos)" }, { status: 400 });
  }

  const { id } = await params;
  const action = await getPendingActionByPublicId(id);
  if (!action || action.kind !== "purchase" || !action.purchase) {
    return NextResponse.json(
      { error: "approval not found or expired — ask your agent for a fresh request" },
      { status: 404 },
    );
  }
  if (Date.now() - action.createdAt >= PROPOSAL_MAX_AGE_MS) {
    return NextResponse.json(
      { error: "approval expired — ask your agent to request it again" },
      { status: 410 },
    );
  }

  // The paired wallet MUST be the approval's owner (the human who issued
  // the agent's capability token). This is the authorization.
  if (accountId !== action.ownerAccountId) {
    return NextResponse.json(
      { error: "this approval belongs to a different wallet — connect the wallet your agent serves" },
      { status: 403 },
    );
  }

  await clearPendingAction(action.ownerAccountId, action.id);

  return NextResponse.json({
    ok: true,
    tx_id: txId,
    hashscan_url: `https://hashscan.io/mainnet/transaction/${toMirrorTxId(txId)}`,
  });
}
