/**
 * Voicescape MCP server — approval-link tools for purchase and hire review.
 *
 * Extends the existing approval-link pattern (preview + plain-words +
 * one-tap sign, the /p/<id> flow used by prepare_agent_claim and
 * propose_page_update) to the two highest-stakes pair actions:
 *
 *   1. request_purchase_approval — the agent has a listing the human
 *      wants; instead of dumping raw buyListing hex into chat, it stashes
 *      a "purchase" pending action and returns an approval link. The
 *      human reviews the card, taps Approve, connects their wallet, and
 *      signs buyListing themselves. Server never signs, never submits.
 *   2. request_review_approval — the agent drafted a proof-of-payment hire
 *      review; the human reviews the card and taps Approve, and the
 *      server posts it (claiming the proof tx only at approve time, so an
 *      untapped request never burns the proof).
 *
 * Both tools require a capability token (purchase:propose / review:propose
 * scope) — the ONLY auth, same as propose_page_update. The pending action
 * is owned by the token's human, and the /p/<id> page requires the paired
 * wallet to equal that owner. Nothing executes without the human's tap;
 * untapped requests expire after 24h. The approval system itself
 * (pending-actions.ts) is reused as-is — these tools only add new kinds.
 */

import { ethers } from "ethers";
import {
  USERNAME_RE,
  usernameValidationError,
  lookupBlockpage,
  getRequestContext,
} from "./mcp-tools";
import { validateCapabilityToken } from "./capability-tokens";
import {
  stashPurchaseProposal,
  stashReviewProposal,
  PendingActionConflictError,
} from "./pending-actions";
import {
  preparePurchaseTool,
} from "./mcp-tools-misc";
import type { TownhallDeps } from "./townhall/handlers";
import {
  verifyReviewTx,
  validateReviewInput,
} from "./agents/reviews";
import { checkContent } from "./townhall/content-filter";
import { getTipsAddress } from "../contracts";
import { mirrorBaseUrl } from "./townhall/topics";

type FetchFn = typeof fetch;

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
/** Tips contract (mainnet) — same id as prepare_purchase. */
const TIPS_CONTRACT_ID = "0.0.10854060";

/** Resolve the capability token or return the fail-closed error string. */
async function requireScope(
  args: { capability_token?: unknown },
  scope: "purchase:propose" | "review:propose",
): Promise<{ owner: string; tokenId: string } | { error: string }> {
  const argToken = (args.capability_token ?? "").toString().trim();
  const headerToken = getRequestContext().authToken;
  const rawToken = argToken !== "" ? argToken : headerToken;
  const validated = rawToken ? await validateCapabilityToken(rawToken, scope) : null;
  if (!validated) {
    return {
      error:
        "invalid, expired, or revoked capability token — ask the human to issue a fresh one (they do it once in their wallet session; the token is shown once and lives in secure credential storage, never in chat). " +
        "Pass it as the capability_token argument, or send it as the HTTP Authorization: Bearer <redacted>",
    };
  }
  return { owner: validated.record.ownerAccountId, tokenId: validated.record.id };
}

function approvalUrlFor(actionId: string): string {
  return `${getRequestContext().origin.replace(/\/$/, "")}/p/${actionId}`;
}

/* ------------------------------------------------------------------ */
/* request_purchase_approval                                           */
/* ------------------------------------------------------------------ */

export interface RequestPurchaseApprovalArgs {
  listing_id: string;
  capability_token?: string;
}

export interface PurchaseApprovalRequest {
  approval_id: string;
  listing: {
    id: string;
    title: string;
    seller: string;
    price_usd_cents: number;
  };
  you_pay_hbar: string;
  split: string;
  status: "awaiting_human_approval";
  expires_in: string;
  approval_url: string;
  next: string;
}

export async function requestPurchaseApprovalTool(
  args: RequestPurchaseApprovalArgs,
  depsOverride?: TownhallDeps,
  fetchFn: FetchFn = fetch,
): Promise<PurchaseApprovalRequest | { error: string }> {
  // 1. Capability token — the ONLY auth. Must carry purchase:propose.
  const auth = await requireScope(args, "purchase:propose");
  if ("error" in auth) return auth;
  const tokenOwner = auth.owner;

  // 2. Reuse prepare_purchase wholesale: listing lookup, active check,
  //    price computation, calldata. Any failure is the honest error.
  const prepared = await preparePurchaseTool(
    { listing_id: args.listing_id },
    depsOverride,
    fetchFn,
  );
  if ("error" in prepared) return prepared;

  // 3. Recover the seller EVM address from the prepared calldata.
  //    prepare_purchase is reused as-is (untouched): the calldata it
  //    built is buyListing(address seller, string listingRef), so the
  //    first ABI param is exactly the address the human's wallet will
  //    sign — the source of truth, no second resolution needed.
  let sellerEvm: string;
  try {
    const data = prepared.unsigned_calldata.startsWith("0x")
      ? prepared.unsigned_calldata
      : `0x${prepared.unsigned_calldata}`;
    const [decoded] = new ethers.AbiCoder().decode(
      ["address", "string"],
      `0x${data.slice(10)}`,
    ) as unknown as [string, string];
    sellerEvm = decoded.toLowerCase();
  } catch {
    return { error: `could not read the prepared purchase for listing "${prepared.listing.id}" — try again in a moment` };
  }
  if (!EVM_RE.test(sellerEvm)) {
    return { error: `could not resolve the seller of listing "${prepared.listing.id}"` };
  }

  // 4. Stash the purchase proposal — nothing is signed or submitted until
  //    the human taps Approve on the link and signs in their own wallet.
  try {
    const action = await stashPurchaseProposal({
      owner_account_id: tokenOwner,
      purchase: {
        listingId: prepared.listing.id,
        title: prepared.listing.title,
        seller: prepared.listing.seller,
        sellerEvm: sellerEvm.toLowerCase(),
        contractId: TIPS_CONTRACT_ID,
        priceUsdCents: prepared.listing.price_usd_cents,
        valueTinybar: prepared.value_tinybar,
        valueHbar: prepared.value_hbar,
      },
      token_id: auth.tokenId,
    });
    const approval_url = approvalUrlFor(action.id);
    return {
      approval_id: action.id,
      listing: {
        id: prepared.listing.id,
        title: prepared.listing.title,
        seller: prepared.listing.seller,
        price_usd_cents: prepared.listing.price_usd_cents,
      },
      you_pay_hbar: prepared.value_hbar,
      split: "98% to the seller, 2% to the platform — enforced atomically by the Tips contract, no escrow",
      status: "awaiting_human_approval",
      expires_in: "24h",
      approval_url,
      next:
        `Share this approval link with your human in YOUR OWN chat: ${approval_url} — ` +
        `they open it, review "${prepared.listing.title}" at ${prepared.value_hbar} HBAR, tap Approve, connect their wallet, ` +
        `and sign the buyListing call themselves (a few cents of HBAR network gas on top). Nothing is signed and no ` +
        `funds move until they tap. Do not paste raw calldata — the link IS the approval surface. ` +
        `Untapped requests expire after 24h.`,
    };
  } catch (e) {
    if (e instanceof PendingActionConflictError) {
      return {
        error:
          `the human already has 3 pending approvals — ask them to clear their Buddy chat inbox first, then try again`,
      };
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* request_review_approval                                             */
/* ------------------------------------------------------------------ */

export interface RequestReviewApprovalArgs {
  agent_username: string;
  target_username: string;
  proof_tx_id: string;
  rating: number;
  text?: string;
  capability_token?: string;
}

export interface ReviewApprovalRequest {
  approval_id: string;
  review: {
    reviewer: string;
    target: string;
    rating: number;
    text: string;
    proof_tx_id: string;
    proof_kind: "tip" | "purchase";
  };
  status: "awaiting_human_approval";
  expires_in: string;
  approval_url: string;
  next: string;
}

export async function requestReviewApprovalTool(
  args: RequestReviewApprovalArgs,
  fetchFn: FetchFn = fetch,
): Promise<ReviewApprovalRequest | { error: string }> {
  // 1. Capability token — the ONLY auth. Must carry review:propose.
  const auth = await requireScope(args, "review:propose");
  if ("error" in auth) return auth;
  const tokenOwner = auth.owner;

  // 2. Resolve the reviewing agent's on-chain identity.
  const agentName = (args.agent_username ?? "").toString().trim().toLowerCase();
  if (!USERNAME_RE.test(agentName)) return { error: usernameValidationError(args.agent_username) };
  const page = await lookupBlockpage(agentName, fetchFn);
  if (!page.found) {
    return { error: `@${agentName} is not a registered blockpage — check the name with lookup_blockpage` };
  }
  const ownerEvm = (page.owner_evm ?? "").toLowerCase();
  if (!EVM_RE.test(ownerEvm)) {
    return { error: `could not resolve the on-chain owner of @${agentName} — try again in a moment` };
  }

  // 3. Resolve the target page's owner.
  const target = (args.target_username ?? "").toString().trim().toLowerCase();
  if (!USERNAME_RE.test(target)) return { error: usernameValidationError(args.target_username) };
  const tp = await lookupBlockpage(target, fetchFn);
  if (!tp.found) return { error: `no page is registered for "${target}"` };
  const targetEvm = (tp.owner_evm ?? "").toLowerCase();
  if (!EVM_RE.test(targetEvm)) {
    return { error: `could not resolve the on-chain owner of "${target}" — try again in a moment` };
  }
  if (ownerEvm === targetEvm) {
    return { error: "cannot review your own page" };
  }

  // 4. Validate the review input (rating, text, tx id shape).
  const input = validateReviewInput({
    txId: args.proof_tx_id,
    rating: args.rating,
    text: args.text ?? "",
  });
  if (!input.ok) return { error: input.error };
  if (input.input.text) {
    const check = checkContent(input.input.text, "review");
    if (!check.allowed) {
      return { error: `review blocked: ${check.reason ?? "not allowed"}` };
    }
  }

  // 5. Verify the proof-of-payment tx against the mirror node — but do NOT
  //    claim it. Claiming happens at approve time; an untapped request
  //    must never burn the proof.
  const tips = getTipsAddress();
  if (!tips) {
    return { error: "tips contract is not configured — try again in a moment" };
  }
  const tipsId = tips.startsWith("0x") ? TIPS_CONTRACT_ID : tips;
  const proven = await verifyReviewTx(
    input.input.txId,
    ownerEvm,
    targetEvm,
    { fetchFn, mirrorBaseUrl: mirrorBaseUrl(), tipsAddress: tipsId },
  );
  if (!proven.ok) return { error: proven.error };

  // 6. Stash the review proposal — nothing posts until the human taps.
  try {
    const action = await stashReviewProposal({
      owner_account_id: tokenOwner,
      review: {
        reviewerUsername: agentName,
        reviewerEvm: ownerEvm,
        targetUsername: target,
        targetEvm,
        rating: input.input.rating,
        text: input.input.text,
        proofTxId: input.input.txId,
        proofKind: proven.kind,
      },
      token_id: auth.tokenId,
    });
    const approval_url = approvalUrlFor(action.id);
    return {
      approval_id: action.id,
      review: {
        reviewer: agentName,
        target,
        rating: input.input.rating,
        text: input.input.text,
        proof_tx_id: input.input.txId,
        proof_kind: proven.kind,
      },
      status: "awaiting_human_approval",
      expires_in: "24h",
      approval_url,
      next:
        `Share this approval link with your human in YOUR OWN chat: ${approval_url} — ` +
        `they open it, review the ${input.input.rating}/5 review of @${target} backed by on-chain payment ` +
        `${input.input.txId}, and tap Approve to post it. Nothing posts until they tap. ` +
        `Untapped requests expire after 24h.`,
    };
  } catch (e) {
    if (e instanceof PendingActionConflictError) {
      return {
        error:
          `the human already has 3 pending approvals — ask them to clear their Buddy chat inbox first, then try again`,
      };
    }
    throw e;
  }
}
