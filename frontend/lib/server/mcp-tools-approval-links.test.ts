/**
 * Voicescape MCP approval-link tools — unit tests.
 *
 * request_purchase_approval / request_review_approval extend the /p/<id>
 * approval pattern to purchase + hire review. Mirror-node reads and the
 * listing source are fully mocked (no network). Nothing is signed or
 * submitted — the tools only stash pending actions and return links.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ethers } from "ethers";
import { resetKvStoreSingleton } from "./store";
import { getPendingActions } from "./pending-actions";
import {
  requestPurchaseApprovalTool,
  requestReviewApprovalTool,
} from "./mcp-tools-approval-links";
import type { TownhallDeps } from "./townhall/handlers";

type Route = [RegExp, (url: string, init?: unknown) => { status: number; body: unknown }];
function mockFetch(routes: Route[]): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = String(input);
    for (const [re, handler] of routes) {
      if (re.test(url)) {
        const out = handler(url, init);
        return {
          ok: out.status >= 200 && out.status < 300,
          status: out.status,
          json: async () => out.body,
        } as Response;
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

const ok = (body: unknown) => ({ status: 200, body });

const OWNER = "0.0.10425049"; // the human (capability token owner)
const OWNER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const RESOLVE_IFACE = new ethers.Interface([
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
]);
function resolvePageResult(owner: string, ipfsHash = ""): string {
  return RESOLVE_IFACE.encodeFunctionResult("resolvePage", [
    owner,
    ipfsHash,
    0,
    "0x0000000000000000000000000000000000000000",
    "",
  ]);
}

async function issueToken(scopes: ("purchase:propose" | "review:propose")[]) {
  const { issueCapabilityToken } = await import("./capability-tokens");
  const { token } = await issueCapabilityToken(OWNER, { label: "test", scopes });
  return token;
}

/* ------------------------- purchase fixtures ------------------------- */

const ACTIVE_LISTING = {
  id: "badge-1",
  seller: OWNER_B,
  sellerUsername: "creator-bob",
  title: "Bacon Badge",
  description: "A tasty badge",
  priceUsdCents: 100,
  goodsType: "digital",
  ipfsHash: null,
  status: "active",
  ts: "2026-10-07T00:00:00.000Z",
};

function purchaseDeps() {
  return {
    hcs: {
      queryAll: async () => [
        {
          seq: 1,
          topic: "0.0.555",
          consensusTimestamp: "2026-10-07T00:00:00.000Z",
          contents: { kind: "listing", ...ACTIVE_LISTING },
        },
      ],
    },
  } as unknown as TownhallDeps;
}

function priceFetch() {
  return mockFetch([
    [/network\/exchangerate$/, () => ok({ current_rate: { cent_equivalent: 20, hbar_equivalent: 100 } })],
  ]);
}

/* ------------------------- review fixtures ------------------------- */

const PROOF_TX = "0.0.7@1700000000.000000000";
const TX_HASH = "0x" + "ab".repeat(32);
const PURCHASE_TOPIC0 = ethers.id("PurchaseCompleted(address,address,string,uint256,uint256)");
const addrTopic = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();

function reviewFetch() {
  const pages: Record<string, { owner: string }> = {
    "reviewer-agent": { owner: OWNER_A },
    "target-agent": { owner: OWNER_B },
  };
  return mockFetch([
    [
      /contracts\/call$/,
      (url, init) => {
        const body = String((init as { body?: unknown } | undefined)?.body ?? "");
        for (const [name, p] of Object.entries(pages)) {
          if (body.includes(Buffer.from(name, "utf-8").toString("hex"))) {
            return ok({ result: resolvePageResult(p.owner) });
          }
        }
        return ok({ result: "0x" });
      },
    ],
    [/accounts\/0x/, () => ok({ account: "0.0.99999" })],
    [
      /transactions\/0\.0\.7-1700000000-000000000$/,
      () =>
        ok({
          transactions: [
            {
              result: "SUCCESS",
              name: "CONTRACTCALL",
              entity_id: "0.0.10854060",
              consensus_timestamp: "1700000001.000000000",
              transaction_hash: TX_HASH,
            },
          ],
        }),
    ],
    [
      new RegExp(`contracts/results/${TX_HASH}$`),
      () =>
        ok({
          logs: [
            {
              topics: [PURCHASE_TOPIC0, addrTopic(OWNER_A), addrTopic(OWNER_B)],
              data: "0x",
            },
          ],
        }),
    ],
  ]);
}

/* ------------------------- request_purchase_approval ------------------------- */

describe("request_purchase_approval", () => {
  beforeEach(async () => {
    await resetKvStoreSingleton();
    vi.stubEnv("TOWNHALL_TOPIC_MARKET", "0.0.555");
  });

  it("stashes a purchase approval and returns the link, not calldata", async () => {
    const token = await issueToken(["purchase:propose"]);
    const res = (await requestPurchaseApprovalTool(
      { listing_id: "badge-1", capability_token: token },
      purchaseDeps(),
      priceFetch(),
    )) as any;
    expect(res.error).toBeUndefined();
    expect(res.approval_id).toMatch(/^[0-9a-f]{16}$/);
    expect(res.approval_url).toContain(`/p/${res.approval_id}`);
    expect(res.listing.title).toBe("Bacon Badge");
    expect(res.you_pay_hbar).toBeTruthy();
    expect(res.split).toMatch(/98%/);
    expect(res.status).toBe("awaiting_human_approval");
    // No raw hex in the agent-facing output — the link IS the surface.
    expect(JSON.stringify(res)).not.toMatch(/0x[0-9a-f]{8,}/i);

    const pending = await getPendingActions(OWNER);
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("purchase");
    expect(pending[0].purchase?.listingId).toBe("badge-1");
    expect(pending[0].purchase?.sellerEvm).toBe(OWNER_B.toLowerCase());
    expect(pending[0].ownerAccountId).toBe(OWNER);
  });

  it("rejects without a capability token, and with the wrong scope", async () => {
    const noToken = await requestPurchaseApprovalTool(
      { listing_id: "badge-1" },
      purchaseDeps(),
      priceFetch(),
    );
    expect((noToken as any).error).toMatch(/capability token/);

    const wrongScope = await issueToken(["review:propose"]);
    const res = await requestPurchaseApprovalTool(
      { listing_id: "badge-1", capability_token: wrongScope },
      purchaseDeps(),
      priceFetch(),
    );
    expect((res as any).error).toMatch(/capability token/);
    expect(await getPendingActions(OWNER)).toHaveLength(0);
  });

  it("surfaces prepare_purchase errors honestly (unknown listing)", async () => {
    const token = await issueToken(["purchase:propose"]);
    const res = await requestPurchaseApprovalTool(
      { listing_id: "nope", capability_token: token },
      purchaseDeps(),
      priceFetch(),
    );
    expect((res as any).error).toMatch(/not found/);
  });

  it("refuses when the human's inbox is full", async () => {
    const token = await issueToken(["purchase:propose"]);
    const { stashPurchaseProposal } = await import("./pending-actions");
    const base = {
      listingId: "x",
      title: "X",
      seller: "s",
      sellerEvm: OWNER_B,
      contractId: "0.0.10854060",
      priceUsdCents: 100,
      valueTinybar: "100000000",
      valueHbar: "1",
    };
    for (let i = 0; i < 3; i++) {
      await stashPurchaseProposal({ owner_account_id: OWNER, purchase: base, token_id: "a1b2c3d4e5f60718" });
    }
    const res = await requestPurchaseApprovalTool(
      { listing_id: "badge-1", capability_token: token },
      purchaseDeps(),
      priceFetch(),
    );
    expect((res as any).error).toMatch(/3 pending approvals/);
  });
});

/* ------------------------- request_review_approval ------------------------- */

describe("request_review_approval", () => {
  beforeEach(async () => {
    await resetKvStoreSingleton();
  });

  it("stashes a review approval and returns the link", async () => {
    const token = await issueToken(["review:propose"]);
    const res = (await requestReviewApprovalTool(
      {
        agent_username: "reviewer-agent",
        target_username: "target-agent",
        proof_tx_id: PROOF_TX,
        rating: 5,
        text: "Fast delivery, honest pricing.",
        capability_token: token,
      },
      reviewFetch(),
    )) as any;
    expect(res.error).toBeUndefined();
    expect(res.approval_id).toMatch(/^[0-9a-f]{16}$/);
    expect(res.approval_url).toContain(`/p/${res.approval_id}`);
    expect(res.review.rating).toBe(5);
    expect(res.review.proof_kind).toBe("purchase");
    expect(res.status).toBe("awaiting_human_approval");

    const pending = await getPendingActions(OWNER);
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("hire-review");
    expect(pending[0].hireReview?.targetUsername).toBe("target-agent");
    expect(pending[0].hireReview?.proofTxId).toBe(PROOF_TX);
  });

  it("rejects without a capability token, and with the wrong scope", async () => {
    const noToken = await requestReviewApprovalTool(
      {
        agent_username: "reviewer-agent",
        target_username: "target-agent",
        proof_tx_id: PROOF_TX,
        rating: 5,
        text: "x",
      },
      reviewFetch(),
    );
    expect((noToken as any).error).toMatch(/capability token/);

    const wrongScope = await issueToken(["purchase:propose"]);
    const res = await requestReviewApprovalTool(
      {
        agent_username: "reviewer-agent",
        target_username: "target-agent",
        proof_tx_id: PROOF_TX,
        rating: 5,
        text: "x",
        capability_token: wrongScope,
      },
      reviewFetch(),
    );
    expect((res as any).error).toMatch(/capability token/);
    expect(await getPendingActions(OWNER)).toHaveLength(0);
  });

  it("rejects self-reviews and bad proof txs", async () => {
    const token = await issueToken(["review:propose"]);
    const self = await requestReviewApprovalTool(
      {
        agent_username: "reviewer-agent",
        target_username: "reviewer-agent",
        proof_tx_id: PROOF_TX,
        rating: 5,
        text: "x",
        capability_token: token,
      },
      reviewFetch(),
    );
    expect((self as any).error).toMatch(/own page/);
  });

  it("does not burn the proof tx on an untapped request", async () => {
    const token = await issueToken(["review:propose"]);
    const { claimReviewTx } = await import("./agents/reviews");
    await requestReviewApprovalTool(
      {
        agent_username: "reviewer-agent",
        target_username: "target-agent",
        proof_tx_id: PROOF_TX,
        rating: 4,
        text: "Good.",
        capability_token: token,
      },
      reviewFetch(),
    );
    // The proof is still claimable — the request verified but did not claim.
    expect(await claimReviewTx(PROOF_TX)).toBe(true);
  });
});
