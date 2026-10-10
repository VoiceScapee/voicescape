/**
 * POST /api/page-updates/[id]/finalize — pairing-first approve for a
 * keyless-agent page update proposal, for the approval link (/p/<id>).
 *
 * Body: { account_id: "0.0.x" } — the wallet the human just paired on the
 * approval page. The agent dropped the /p/<id> link in its OWN chat, so the
 * human never needs the dapp's Buddy chat or a session.
 *
 * Auth: none beyond the unguessable proposal id — the output is unsigned
 * bytes; only the proposal owner's wallet can sign them, and the wallet's
 * own confirmation screen is the authorization. The paired account MUST
 * equal the proposal's owner (the human who issued the agent's capability
 * token); anything else is rejected. On-chain ownership is re-verified at
 * tap time. Only updatePage(username, newCid) is ever built — no fund
 * movement, no ownership change, no key change. Rate-limited per IP.
 * Never touches keys; never signs.
 */
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { getPendingActionByPublicId } from "@/lib/server/pending-actions";
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
    "page-update-link-finalize",
    "PAGE_UPDATE_LINK_FINALIZE_IP_LIMIT",
    20,
    "too many approval attempts — try again in a bit",
  );
  if (gated) return gated;

  let accountId = "";
  try {
    const body = (await req.json()) as { account_id?: unknown };
    accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
  } catch {
    return NextResponse.json({ error: "body must be JSON with account_id" }, { status: 400 });
  }
  if (!/^\d+\.\d+\.\d+$/.test(accountId)) {
    return NextResponse.json({ error: "account_id must be a 0.0.x Hedera account" }, { status: 400 });
  }

  const { id } = await params;
  const action = await getPendingActionByPublicId(id);
  if (!action || action.kind !== "agent-page-update" || !action.pageUpdate) {
    return NextResponse.json(
      { error: "proposal not found or expired — ask your agent for a fresh proposal" },
      { status: 404 },
    );
  }
  if (Date.now() - action.createdAt >= PROPOSAL_MAX_AGE_MS) {
    return NextResponse.json(
      { error: "proposal expired — ask your agent to propose it again" },
      { status: 410 },
    );
  }

  // The paired wallet MUST be the proposal's owner (the human who issued
  // the agent's capability token). This is the authorization — a different
  // wallet cannot approve someone else's proposal, and the unsigned output
  // below is signable only by this account anyway.
  if (accountId !== action.ownerAccountId) {
    return NextResponse.json(
      { error: "this proposal belongs to a different wallet — connect the wallet that owns the page" },
      { status: 403 },
    );
  }

  const username = action.pageUpdate.spec.username;
  // Re-verify on-chain ownership at approve time (kills the propose/approve race).
  const page = await lookupBlockpage(username);
  if (!page.found || !page.owner_account || page.owner_account !== accountId) {
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
    built = buildOwnerUpdatePageTx({ ownerAccountId: accountId, username, ipfsCid: cid });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not build the update transaction" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    username,
    owner_account_id: accountId,
    unsignedTxBytes: built.unsignedTxBytes,
    transactionId: built.transactionId,
    signerAccountId: accountId,
    cid,
    label: action.label,
    title: action.title,
    summary: action.summary,
    costEstimate: action.costEstimate,
    note: "Review the summary, then sign once in your wallet. Network gas only — a few cents of HBAR.",
  });
}
