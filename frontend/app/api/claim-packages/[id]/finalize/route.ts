/**
 * POST /api/claim-packages/[id]/finalize — pairing-first finalize.
 *
 * Body: { account_id: "0.0.x" } — the wallet the human just paired on the
 * approval page. The server re-validates the username is still free
 * (kills the prepare-time availability race), pins the starter agent page
 * to IPFS (pinning at prepare time orphans a page every untapped
 * proposal), and builds the frozen UNSIGNED registerPage transaction with
 * the ACTUALLY CONNECTED account as payer. Whoever pairs owns it.
 *
 * Auth: none beyond the unguessable package id — the output is unsigned
 * bytes; only the named account's wallet can sign them, and the wallet's
 * own confirmation screen is the authorization. Rate-limited per IP.
 * Never touches keys; never signs.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  getClaimPackage,
  saveClaimPackage,
} from "@/lib/server/claim-packages";
import {
  lookupBlockpage,
  pinAgentPage,
  evmAddressForAccount,
  REGISTRY_EVM,
  REGISTRY_ID,
  MIRROR_BASE,
} from "@/lib/server/mcp-tools";
import { buildRegisterTransaction } from "@/lib/server/agents/executor";
import { ipGate } from "@/lib/server/rate-limit";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gated = await ipGate(
    req,
    "claim-finalize",
    "CLAIM_FINALIZE_IP_LIMIT",
    20,
    "too many approval attempts — try again in a bit",
  );
  if (gated) return gated;

  const { id } = await params;
  const pkg = await getClaimPackage(id);
  if (!pkg) {
    return NextResponse.json(
      { error: "this approval link is invalid or expired — ask your agent for a fresh one" },
      { status: 404 },
    );
  }

  let accountId = "";
  try {
    const body = (await req.json()) as { account_id?: unknown };
    accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
  } catch {
    return NextResponse.json({ error: "body must be JSON with account_id" }, { status: 400 });
  }
  if (!/^0\.0\.\d+$/.test(accountId)) {
    return NextResponse.json(
      { error: "account_id must be a 0.0.x Hedera account" },
      { status: 400 },
    );
  }
  // An explicit owner override on the package wins; otherwise the paired
  // wallet owns the page.
  const owner = pkg.ownerAccountId ?? accountId;

  // 1. The name must STILL be free — checked at prepare time, re-checked
  //    here at tap time so a front-run can't produce a confusing revert.
  let lookup;
  try {
    lookup = await lookupBlockpage(pkg.username);
  } catch {
    return NextResponse.json(
      { error: "registry unreachable — try again in a moment" },
      { status: 503 },
    );
  }
  if (lookup.found) {
    return NextResponse.json(
      { error: `"${pkg.username}" was just registered by someone else — ask your agent for a fresh name` },
      { status: 409 },
    );
  }

  // 2. The payer account must exist (it pays the registerPage gas).
  let funded: boolean | null = null;
  try {
    const res = await fetch(`${MIRROR_BASE}/accounts/${owner}`, {
      headers: { Accept: "application/json" },
    });
    if (res.status === 404) {
      return NextResponse.json(
        { error: `account ${owner} not found on Hedera mainnet` },
        { status: 400 },
      );
    }
    if (!res.ok) {
      return NextResponse.json(
        { error: "mirror node unreachable — try again in a moment" },
        { status: 503 },
      );
    }
    const body = (await res.json().catch(() => null)) as {
      balance?: { balance?: number };
    } | null;
    const bal = body?.balance?.balance;
    funded = typeof bal === "number" ? bal > 0 : null;
  } catch {
    return NextResponse.json(
      { error: "mirror node unreachable — try again in a moment" },
      { status: 503 },
    );
  }

  // 3. Pin the starter page (once per package — cached on the record).
  let cid = pkg.cid;
  if (!cid) {
    const operator = pkg.operator ?? (await evmAddressForAccount(owner));
    try {
      cid = await pinAgentPage({
        username: pkg.username,
        displayName: pkg.displayName ?? pkg.username,
        purpose: pkg.purpose,
        capabilities: pkg.capabilities ?? [],
        operator,
      });
    } catch (e) {
      return NextResponse.json(
        { error: `could not pin agent page: ${e instanceof Error ? e.message : "pinning failed"}` },
        { status: 502 },
      );
    }
    pkg.cid = cid;
    await saveClaimPackage(pkg);
  }
  const operator = pkg.operator ?? (await evmAddressForAccount(owner));

  // 4. Build the frozen UNSIGNED registerPage transaction (payer = owner).
  let built;
  try {
    built = buildRegisterTransaction(
      { username: pkg.username, ipfsHash: cid, ownerType: 1, operator, purpose: pkg.purpose },
      { payerAccountId: owner, network: "mainnet", registryContractAddress: REGISTRY_EVM },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to build transaction" },
      { status: 500 },
    );
  }

  const whatYoureSigning =
    `registerPage("${pkg.username}") on the Voicescape Registry (${REGISTRY_ID}): ` +
    `registers "${pkg.username}" as an AGENT page owned by ${owner}, ` +
    `with the purpose "${pkg.purpose.slice(0, 120)}". Costs gas only (a few cents). ` +
    `The page content (IPFS ${cid}) can be updated later by the page owner.`;

  return NextResponse.json({
    username: pkg.username,
    owner_account_id: owner,
    unsignedTxBytes: built.unsignedTxBytes,
    transactionId: built.transactionId,
    signerAccountId: `hedera:mainnet:${owner}`,
    label: "Agent blockpage claim",
    title: `Register @${pkg.username}`,
    summary: whatYoureSigning,
    costEstimate: "Network gas only — a few cents of HBAR. No fee to Voicescape.",
    page_url: pkg.pageUrl,
    cid,
    intro_claim_code: pkg.claimCode,
    owner_funded: funded,
  });
}
