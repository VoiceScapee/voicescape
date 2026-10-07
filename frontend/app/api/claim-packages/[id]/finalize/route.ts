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
import { setPackageStatus } from "@/lib/server/package-status";
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
import { getKvStore } from "@/lib/server/store";
import { recordClientError } from "@/lib/server/client-errors";

/**
 * Categorical error return that also records the failure in the shared
 * error aggregates — finalize failures used to vanish into the user's
 * browser; now they surface in /api/admin/errors (founder-gated) next to
 * the MCP tool telemetry. Codes are coarse by design; detail for debugging
 * goes to Vercel logs via console.error at the call site.
 */
async function fail(code: string, message: string, status: number): Promise<Response> {
  try {
    await recordClientError(
      getKvStore(),
      "/api/claim-packages/finalize",
      code,
      "server",
      null,
      Date.now(),
      { action: code },
    );
  } catch {
    /* tracking never blocks the response */
  }
  return NextResponse.json({ error: message }, { status });
}

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
    return fail("link-invalid", "this approval link is invalid or expired — ask your agent for a fresh one", 404);
  }
  // Self-mode packages are claimed by the agent's own key — the human
  // wallet flow must never finalize them.
  if (pkg.mode === "self") {
    return fail(
      "wrong-mode",
      "this package is claimed by the agent's own key — approval happens in the agent's chat, not in a browser wallet",
      400,
    );
  }

  // Idempotent replay for true double-taps: if a finalize completed less
  // than 60s ago, return the SAME unsigned transaction instead of building
  // a second one (the wallet prompt from the first tap may still be open).
  // Beyond that the frozen transaction is expiring — Hedera txs die 120s
  // after valid-start — so a retry ("Try signing again") MUST mint a fresh
  // transaction. Replaying a stale tx guarantees the wallet never prompts
  // and the user is stuck in a dead retry loop (2026-10-04 tester report).
  if (pkg.finalizedResponseJson && pkg.finalizedAt && Date.now() - pkg.finalizedAt < 60_000) {
    try {
      return NextResponse.json(JSON.parse(pkg.finalizedResponseJson));
    } catch {
      /* fall through and rebuild below */
    }
  }

  let accountId = "";
  try {
    const body = (await req.json()) as { account_id?: unknown };
    accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
  } catch {
    return fail("bad-request", "body must be JSON with account_id", 400);
  }
  if (!/^0\.0\.\d+$/.test(accountId)) {
    return fail("bad-account", "account_id must be a 0.0.x Hedera account", 400);
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
    return fail("registry-down", "registry unreachable — try again in a moment", 503);
  }
  if (lookup.found) {
    // Record the loss so the AGENT polling the status endpoint learns the
    // username is gone — previously only the human saw this 409.
    await setPackageStatus("claim", id, "race_lost", {
      username: pkg.username,
      detail: `"${pkg.username}" was registered by someone else before the human tapped — prepare a fresh claim with a different name`,
    });
    return fail(
      "username-taken",
      `"${pkg.username}" was just registered by someone else — ask your agent for a fresh name`,
      409,
    );
  }

  // 2. The payer account must exist (it pays the registerPage gas).
  let funded: boolean | null = null;
  try {
    const res = await fetch(`${MIRROR_BASE}/accounts/${owner}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      return fail("account-not-found", `account ${owner} not found on Hedera mainnet`, 400);
    }
    if (!res.ok) {
      return fail("mirror-down", "mirror node unreachable — try again in a moment", 503);
    }
    const body = (await res.json().catch(() => null)) as {
      balance?: { balance?: number };
    } | null;
    const bal = body?.balance?.balance;
    funded = typeof bal === "number" ? bal > 0 : null;
  } catch {
    return fail("mirror-down", "mirror node unreachable — try again in a moment", 503);
  }

  // 3. Pin the customized page (once per package — cached on the record).
  // Assembled server-side from the template + the agent's customization;
  // page-customize runs the same gates as /api/pin before anything pins.
  let cid = pkg.cid;
  if (!cid) {
    const operator = pkg.operator ?? (await evmAddressForAccount(owner));
    try {
      cid = await pinAgentPage({
        username: pkg.username,
        ownerType: pkg.ownerType === "human" ? "human" : "agent",
        displayName: pkg.displayName ?? pkg.username,
        purpose: pkg.purpose,
        capabilities: pkg.capabilities ?? [],
        operator,
        templateId: pkg.templateId,
        theme: pkg.theme,
        socials: pkg.socials,
        links: pkg.links,
      });
    } catch (e) {
      console.error(`[claim-finalize] pin failed for ${pkg.username}:`, e instanceof Error ? e.message : e);
      return fail("pin-failed", `could not pin page: ${e instanceof Error ? e.message : "pinning failed"}`, 502);
    }
    pkg.cid = cid;
    await saveClaimPackage(pkg);
  }
  const operator = pkg.operator ?? (await evmAddressForAccount(owner));

  // 4. Build the frozen UNSIGNED registerPage transaction (payer = owner).
  const ownerTypeNum = pkg.ownerType === "human" ? 0 : 1;
  let built;
  try {
    built = buildRegisterTransaction(
      { username: pkg.username, ipfsHash: cid, ownerType: ownerTypeNum, operator, purpose: pkg.purpose },
      { payerAccountId: owner, network: "mainnet", registryContractAddress: REGISTRY_EVM },
    );
  } catch (e) {
    console.error(`[claim-finalize] tx build failed for ${pkg.username}:`, e instanceof Error ? e.message : e);
    return fail("tx-build-failed", e instanceof Error ? e.message : "failed to build transaction", 500);
  }

  const kindWord = pkg.ownerType === "human" ? "a HUMAN" : "an AGENT";
  const whatYoureSigning =
    `registerPage("${pkg.username}") on the Voicescape Registry (${REGISTRY_ID}): ` +
    `registers "${pkg.username}" as ${kindWord} page owned by ${owner}, ` +
    `with the purpose "${pkg.purpose.slice(0, 120)}". Costs gas only (a few cents). ` +
    `The page content (IPFS ${cid}) can be updated later by the page owner.`;

  const responseBody = {
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
    status_url: `/api/claim-packages/${id}/status`,
  };

  // Cache the response for double-tap idempotency (replayed only when
  // fresh — see above). Rebuilding on every retry is what keeps "Try
  // signing again" working after a wallet timeout.
  pkg.finalizedAt = Date.now();
  pkg.finalizedResponseJson = JSON.stringify(responseBody);
  await saveClaimPackage(pkg);
  await setPackageStatus("claim", id, "awaiting_signature", {
    username: pkg.username,
    transactionId: built.transactionId,
    detail: "unsigned registerPage transaction issued — waiting for the human's wallet signature",
  });

  return NextResponse.json(responseBody);
}
