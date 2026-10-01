/**
 * Proof-of-payment reviews — unit tests.
 *
 * Mirror-node fetch is injected (no network); the KV store is the real
 * in-memory store, cleared between tests with unique key prefixes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import { getKvStore } from "@/lib/server/store";
import {
  addReview,
  aggregateReviews,
  claimReviewTx,
  getReviewSummary,
  listReviews,
  MAX_REVIEWS_PER_AGENT,
  normalizeTxId,
  validateReviewInput,
  verifyReviewTx,
  type VerifiedReview,
  type VerifyDeps,
} from "./reviews";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const TIPS = "0.0.10854060";
const MIRROR = "https://mainnet.mirrornode.hedera.com";
const AGENT_OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REVIEWER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER = "0xcccccccccccccccccccccccccccccccccccccccc";

const TIPSENT_TOPIC0 = ethers.id("TipSent(string,address,address,uint256,uint256)");
const PURCHASE_TOPIC0 = ethers.id("PurchaseCompleted(address,address,string,uint256,uint256)");

// Cross-check: the module's topic hash must equal the canonical on-chain
// value used across the codebase (lib/leaderboard.ts, /api/notifications).
const KNOWN_TIPSENT_TOPIC0 = "0xddb557901a5c7e767f2276c1190ca61ae148d62a74cfa61e4f7fa5319eaa431e";

const padTopic = (addr: string) => "0x" + addr.slice(2).padStart(64, "0");

function tipLog(from: string, to: string) {
  return { topics: [TIPSENT_TOPIC0, padTopic(OTHER), padTopic(from), padTopic(to)], data: "0x" + "0".repeat(128) };
}
function purchaseLog(buyer: string, seller: string) {
  return { topics: [PURCHASE_TOPIC0, padTopic(buyer), padTopic(seller)], data: "0x" };
}

function mockFetch(tx: Record<string, unknown>, logs: unknown[]) {
  return vi.fn(async (url: string) => {
    if (String(url).includes("/api/v1/transactions/")) {
      return { ok: true, status: 200, json: async () => ({ transactions: [tx] }) };
    }
    if (String(url).includes("/api/v1/contracts/results/")) {
      return { ok: true, status: 200, json: async () => ({ logs }) };
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
}

const baseTx = {
  result: "SUCCESS",
  name: "CONTRACTCALL",
  entity_id: TIPS,
  consensus_timestamp: "1700000000.000000001",
  transaction_hash: "0xdeadbeef",
};

const deps = (fetchFn: typeof fetch): VerifyDeps => ({
  fetchFn,
  mirrorBaseUrl: MIRROR,
  tipsAddress: TIPS,
});

const review = (over: Partial<VerifiedReview> = {}): VerifiedReview => ({
  txId: "0.0.7@1700000000.000000001",
  kind: "tip",
  reviewer: REVIEWER,
  reviewerUsername: null,
  rating: 5,
  text: "great work",
  timestamp: new Date().toISOString(),
  ...over,
});

beforeEach(async () => {
  await getKvStore().clearPrefix("agent:reviews:");
  await getKvStore().clearPrefix("review:tx:");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* normalizeTxId                                                       */
/* ------------------------------------------------------------------ */

describe("normalizeTxId", () => {
  it("accepts the @-form", () => {
    expect(normalizeTxId("0.0.123@1700000000.000000001")).toBe("0.0.123@1700000000.000000001");
  });
  it("accepts the dash-form", () => {
    expect(normalizeTxId("0.0.123-1700000000-000000001")).toBe("0.0.123@1700000000.000000001");
  });
  it("rejects garbage", () => {
    expect(normalizeTxId("nope")).toBeNull();
    expect(normalizeTxId("0.0.123")).toBeNull();
    expect(normalizeTxId(42)).toBeNull();
    expect(normalizeTxId("")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* validateReviewInput                                                 */
/* ------------------------------------------------------------------ */

describe("validateReviewInput", () => {
  const good = { txId: "0.0.123@1700000000.000000001", rating: 5, text: "solid" };
  it("accepts a valid body", () => {
    expect(validateReviewInput(good)).toEqual({ ok: true, input: { ...good, text: "solid" } });
  });
  it("rejects a bad txId", () => {
    const r = validateReviewInput({ ...good, txId: "bogus" });
    expect(r.ok).toBe(false);
  });
  it("rejects out-of-range and non-integer ratings", () => {
    for (const rating of [0, 6, 2.5, "5", null]) {
      expect(validateReviewInput({ ...good, rating }).ok).toBe(false);
    }
    expect(validateReviewInput({ ...good, rating: 1 }).ok).toBe(true);
  });
  it("rejects over-long text and non-string text", () => {
    expect(validateReviewInput({ ...good, text: "x".repeat(501) }).ok).toBe(false);
    expect(validateReviewInput({ ...good, text: "x".repeat(500) }).ok).toBe(true);
    expect(validateReviewInput({ ...good, text: 42 }).ok).toBe(false);
  });
  it("rejects non-object bodies", () => {
    expect(validateReviewInput(null).ok).toBe(false);
    expect(validateReviewInput("str").ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* verifyReviewTx                                                      */
/* ------------------------------------------------------------------ */

describe("verifyReviewTx", () => {
  it("topic hash matches the canonical on-chain TipSent value", () => {
    expect(TIPSENT_TOPIC0).toBe(KNOWN_TIPSENT_TOPIC0);
  });

  it("accepts a valid tip to the agent's owner", async () => {
    const r = await verifyReviewTx(
      "0.0.7@1700000000.000000001",
      REVIEWER,
      AGENT_OWNER,
      deps(mockFetch(baseTx, [tipLog(REVIEWER, AGENT_OWNER)])),
    );
    expect(r).toEqual({ ok: true, kind: "tip", sender: REVIEWER });
  });

  it("accepts a valid purchase from the agent's owner", async () => {
    const r = await verifyReviewTx(
      "0.0.7@1700000000.000000001",
      REVIEWER,
      AGENT_OWNER,
      deps(mockFetch(baseTx, [purchaseLog(REVIEWER, AGENT_OWNER)])),
    );
    expect(r).toEqual({ ok: true, kind: "purchase", sender: REVIEWER });
  });

  it("rejects a tip to a different recipient", async () => {
    const r = await verifyReviewTx(
      "0.0.7@1700000000.000000001",
      REVIEWER,
      AGENT_OWNER,
      deps(mockFetch(baseTx, [tipLog(REVIEWER, OTHER)])),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  it("rejects when the event sender is not the reviewer's wallet", async () => {
    const r = await verifyReviewTx(
      "0.0.7@1700000000.000000001",
      REVIEWER,
      AGENT_OWNER,
      deps(mockFetch(baseTx, [tipLog(OTHER, AGENT_OWNER)])),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("rejects a purchase from a different seller", async () => {
    const r = await verifyReviewTx(
      "0.0.7@1700000000.000000001",
      REVIEWER,
      AGENT_OWNER,
      deps(mockFetch(baseTx, [purchaseLog(REVIEWER, OTHER)])),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  it("rejects failed transactions", async () => {
    const r = await verifyReviewTx(
      "0.0.7@1700000000.000000001",
      REVIEWER,
      AGENT_OWNER,
      deps(mockFetch({ ...baseTx, result: "INSUFFICIENT_PAYER_BALANCE" }, [])),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  it("rejects calls to other contracts", async () => {
    const r = await verifyReviewTx(
      "0.0.7@1700000000.000000001",
      REVIEWER,
      AGENT_OWNER,
      deps(mockFetch({ ...baseTx, entity_id: "0.0.999" }, [])),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  it("rejects non-contract-call transactions", async () => {
    const r = await verifyReviewTx(
      "0.0.7@1700000000.000000001",
      REVIEWER,
      AGENT_OWNER,
      deps(mockFetch({ ...baseTx, name: "CRYPTOTRANSFER", entity_id: TIPS }, [])),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  it("404s a missing transaction", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const r = await verifyReviewTx("0.0.7@1700000000.000000001", REVIEWER, AGENT_OWNER, deps(fetchFn));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("fails closed (503) when the mirror node is unreachable", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const r = await verifyReviewTx("0.0.7@1700000000.000000001", REVIEWER, AGENT_OWNER, deps(fetchFn));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });

  it("rejects when no relevant event exists in the tx", async () => {
    const r = await verifyReviewTx(
      "0.0.7@1700000000.000000001",
      REVIEWER,
      AGENT_OWNER,
      deps(mockFetch(baseTx, [{ topics: ["0x" + "ff".repeat(32)] }])),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  it("ignores malformed logs and keeps scanning", async () => {
    const r = await verifyReviewTx(
      "0.0.7@1700000000.000000001",
      REVIEWER,
      AGENT_OWNER,
      deps(mockFetch(baseTx, [{ topics: [] }, tipLog(REVIEWER, AGENT_OWNER)])),
    );
    expect(r).toEqual({ ok: true, kind: "tip", sender: REVIEWER });
  });
});

/* ------------------------------------------------------------------ */
/* Storage: claims, append, aggregation                                */
/* ------------------------------------------------------------------ */

describe("review storage", () => {
  it("claimReviewTx allows one claim per txId", async () => {
    expect(await claimReviewTx("0.0.7@1700000000.000000001")).toBe(true);
    expect(await claimReviewTx("0.0.7@1700000000.000000001")).toBe(false);
    expect(await claimReviewTx("0.0.7@1700000000.000000002")).toBe(true);
  });

  it("addReview stores newest-first and summarizes", async () => {
    await addReview("forge", review({ rating: 5, txId: "0.0.7@1.1" }));
    await addReview("forge", review({ rating: 3, txId: "0.0.7@2.2" }));
    const list = await listReviews("forge", 50);
    expect(list.count).toBe(2);
    expect(list.avg).toBe(4);
    expect(list.reviews[0].txId).toBe("0.0.7@2.2"); // newest first
    expect(list.reviews[1].txId).toBe("0.0.7@1.1");
  });

  it("usernames are case-insensitive", async () => {
    await addReview("Forge", review({ txId: "0.0.7@3.3" }));
    const list = await listReviews("forge", 50);
    expect(list.count).toBe(1);
  });

  it("returns an empty list with null avg when there are no reviews", async () => {
    const list = await listReviews("nobody", 50);
    expect(list).toEqual({ reviews: [], count: 0, avg: null });
    expect(await getReviewSummary("nobody")).toBeNull();
  });

  it("paginates with a max of 50", async () => {
    for (let i = 0; i < 5; i++) {
      await addReview("paged", review({ txId: `0.0.7@4.${i}`, rating: 4 }));
    }
    const list = await listReviews("paged", 2);
    expect(list.reviews).toHaveLength(2);
    expect(list.count).toBe(5);
    const capped = await listReviews("paged", 9999);
    expect(capped.reviews).toHaveLength(5); // only 5 stored; cap is 50
  });

  it("caps stored reviews at MAX_REVIEWS_PER_AGENT", async () => {
    for (let i = 0; i < MAX_REVIEWS_PER_AGENT + 10; i++) {
      await addReview("capped", review({ txId: `0.0.7@5.${i}`, rating: 5 }));
    }
    const list = await listReviews("capped", 500);
    expect(list.count).toBe(MAX_REVIEWS_PER_AGENT);
  });

  it("aggregateReviews rounds the average to 1 decimal", () => {
    expect(aggregateReviews([review({ rating: 5 }), review({ rating: 4 }), review({ rating: 4 })])?.avg).toBe(4.3);
    expect(aggregateReviews([])).toBeNull();
  });
});
