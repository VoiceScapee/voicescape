/**
 * POST /api/agents/page-updates/[id]/finalize — one-tap approve for a
 * keyless-agent page update proposal.
 *
 * Session-authenticated (x-vs-session); strictly per-owner. The human's tap
 * IS the authorization: this route pins the proposed page to IPFS and
 * builds the frozen UNSIGNED updatePage transaction with the owner's
 * account as payer/signer. The human's wallet signs once on its own
 * confirmation screen — one signature publishes the update.
 *
 * Safety, enforced here (not just promised):
 * - The proposal must exist in THIS owner's inbox, be an
 *   agent-page-update, and be younger than 24h.
 * - On-chain ownership is re-verified at approve time (kills the
 *   prepare/approve race): lookupBlockpage(username).owner_account must
 *   equal the session owner.
 * - Only updatePage(username, newCid) is ever built. No fund movement,
 *   no ownership change, no key change — the builder has no code path
 *   for anything else.
 * - Never stores keys, never signs. Rate-limited per IP.
 */
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { agentOwnerFromRequest } from "@/lib/server/agent-session";
import { getPendingActionById } from "@/lib/server/pending-actions";
import { lookupBlockpage } from "@/lib/server/mcp-tools";
import { assembleClaimPage } from "@/lib/server/page-customize";
import { publishPageJson } from "@/lib/server/publish.js";
import { buildOwnerUpdatePageTx } from "@/lib/server/update-page-tx";
import { ipGate } from "@/lib/server/rate-limit";

const PROPOSAL_MAX_AGE_MS = 24 * 3_600_000;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gated = await ipGate(
    req,
    "page-update-finalize",
    "PAGE_UPDATE_FINALIZE_IP_LIMIT",
    20,
    "too many approval attempts — try again in a bit",
  );
  if (gated) return gated;

  const owner = await agentOwnerFromRequest(req);
  if (!owner) return NextResponse.json({ error: "sign in required" }, { status: 401 });

  const { id } = await params;
  const action = await getPendingActionById(owner, (id ?? "").trim());
  if (!action || action.kind !== "agent-page-update" || !action.pageUpdate) {
    return NextResponse.json({ error: "proposal not found or expired" }, { status: 404 });
  }
  if (Date.now() - action.createdAt >= PROPOSAL_MAX_AGE_MS) {
    return NextResponse.json({ error: "proposal expired — ask your agent to propose it again" }, { status: 410 });
  }

  const username = action.pageUpdate.spec.username;
  // Re-verify on-chain ownership at approve time.
  const page = await lookupBlockpage(username);
  if (!page.found || !page.owner_account || page.owner_account !== owner) {
    return NextResponse.json(
      { error: "ownership changed since this was proposed — ask your agent to propose it again" },
      { status: 409 },
    );
  }

  // Pin the proposed page (same gates as /api/pin via assembleClaimPage),
  // then build the frozen unsigned updatePage with the owner as signer.
  let cid: string;
  try {
    const assembled = assembleClaimPage(action.pageUpdate.spec);
    const pinned = (await publishPageJson(assembled)) as { cid: string };
    cid = pinned.cid;
    if (!cid) throw new Error("empty cid");
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not pin the updated page" },
      { status: 422 },
    );
  }

  let built;
  try {
    built = buildOwnerUpdatePageTx({ ownerAccountId: owner, username, ipfsCid: cid });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not build the update transaction" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    username,
    owner_account_id: owner,
    unsignedTxBytes: built.unsignedTxBytes,
    transactionId: built.transactionId,
    signerAccountId: owner,
    cid,
    label: action.label,
    title: action.title,
    summary: action.summary,
    costEstimate: action.costEstimate,
    note: "Review the summary, then sign once in your wallet. Network gas only — a few cents of HBAR.",
  });
}
