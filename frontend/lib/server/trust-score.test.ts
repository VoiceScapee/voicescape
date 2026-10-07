/**
 * Trust-score unit tests. The scoring formula is pure and deterministic —
 * these tests pin it. Network is never touched: fetchPaymentStats takes an
 * injected fetch implementation, and computeTrustScore's payment leg is
 * exercised through a mocked fetch.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ethers } from "ethers";
import {
  paymentComponentScore,
  reviewComponentScore,
  voteComponentScore,
  tenureComponentScore,
  tenureDays,
  combineTrustScore,
  fetchPaymentStats,
  computeTrustScore,
  clearTrustCache,
  TRUST_WEIGHTS,
} from "./trust-score";

beforeEach(() => {
  clearTrustCache();
  vi.unstubAllGlobals();
});

describe("paymentComponentScore", () => {
  it("sybil-awareness: many unique payers outrank many txs from one payer", () => {
    const concentrated = paymentComponentScore(10, 1);
    const distributed = paymentComponentScore(3, 3);
    expect(distributed).toBeGreaterThan(concentrated);
  });

  it("saturates at 1 for large volume", () => {
    expect(paymentComponentScore(1000, 1000)).toBe(1);
  });

  it("is 0 with no activity", () => {
    expect(paymentComponentScore(0, 0)).toBe(0);
  });

  it("unique payers dominate raw count", () => {
    // 10 unique payers, 10 txs vs 1 payer, 10 txs
    const wide = paymentComponentScore(10, 10);
    const narrow = paymentComponentScore(10, 1);
    expect(wide).toBeGreaterThan(narrow);
    // wide = 0.7*1 + 0.3*0.4 = 0.82 ; narrow = 0.7*0.1 + 0.3*0.4 = 0.19
    expect(wide).toBeCloseTo(0.82, 6);
    expect(narrow).toBeCloseTo(0.19, 6);
  });
});

describe("reviewComponentScore", () => {
  it("is 0 with no reviews or null avg", () => {
    expect(reviewComponentScore(0, null)).toBe(0);
    expect(reviewComponentScore(0, 4.5)).toBe(0);
    expect(reviewComponentScore(5, null)).toBe(0);
  });

  it("perfect score needs 5 stars and 10+ reviews", () => {
    expect(reviewComponentScore(10, 5)).toBe(1);
  });

  it("blends rating and count", () => {
    // 1 five-star review: 0.6*1 + 0.4*0.1 = 0.64
    expect(reviewComponentScore(1, 5)).toBeCloseTo(0.64, 6);
    // 10 three-star reviews: 0.6*0.6 + 0.4*1 = 0.76
    expect(reviewComponentScore(10, 3)).toBeCloseTo(0.76, 6);
  });
});

describe("voteComponentScore", () => {
  it("is 0 with no votes", () => {
    expect(voteComponentScore(0, 0)).toBe(0);
  });

  it("scales with vote volume", () => {
    // 10 up, 0 down: ratio 1.0 * min(1, 10/20) = 0.5
    expect(voteComponentScore(10, 0)).toBeCloseTo(0.5, 6);
    // 18 up, 2 down: 0.9 * 1 = 0.9
    expect(voteComponentScore(18, 2)).toBeCloseTo(0.9, 6);
  });

  it("downvotes drag the ratio", () => {
    expect(voteComponentScore(5, 5)).toBeCloseTo(0.5 * 0.5, 6);
  });
});

describe("tenureComponentScore / tenureDays", () => {
  const NOW = 1_790_000_000_000; // fixed "now" for determinism

  it("is 0 with no registration timestamp", () => {
    expect(tenureComponentScore(null, NOW)).toBe(0);
    expect(tenureDays(null, NOW)).toBeNull();
  });

  it("caps at one year", () => {
    const twoYearsAgo = `${Math.floor((NOW - 730 * 86_400_000) / 1000)}.000000000`;
    expect(tenureComponentScore(twoYearsAgo, NOW)).toBe(1);
    expect(tenureDays(twoYearsAgo, NOW)).toBe(730);
  });

  it("scales linearly within the first year", () => {
    const hundredDaysAgo = `${Math.floor((NOW - 100 * 86_400_000) / 1000)}.000000000`;
    expect(tenureComponentScore(hundredDaysAgo, NOW)).toBeCloseTo(100 / 365, 6);
  });

  it("rejects garbage timestamps", () => {
    expect(tenureComponentScore("not-a-time", NOW)).toBe(0);
    expect(tenureComponentScore("0.0", NOW)).toBe(0);
  });
});

describe("combineTrustScore", () => {
  it("weights sum to 1", () => {
    const sum =
      TRUST_WEIGHTS.payments + TRUST_WEIGHTS.reviews + TRUST_WEIGHTS.votes + TRUST_WEIGHTS.tenure;
    expect(sum).toBeCloseTo(1, 10);
  });

  it("all-zero components give 0", () => {
    expect(
      combineTrustScore({ paymentScore: 0, reviewScore: 0, voteScore: 0, tenureScore: 0 }),
    ).toBe(0);
  });

  it("all-max components give 100", () => {
    expect(
      combineTrustScore({ paymentScore: 1, reviewScore: 1, voteScore: 1, tenureScore: 1 }),
    ).toBe(100);
  });

  it("clamps out-of-range inputs", () => {
    expect(
      combineTrustScore({ paymentScore: 2, reviewScore: 2, voteScore: 2, tenureScore: 2 }),
    ).toBe(100);
    expect(
      combineTrustScore({ paymentScore: -1, reviewScore: -1, voteScore: -1, tenureScore: -1 }),
    ).toBe(0);
  });

  it("documented example: solid agent lands in the 80s", () => {
    // 8 unique payers / 20 txs, 6 reviews avg 4.5, 15 up / 1 down, 200 days
    const score = combineTrustScore({
      paymentScore: paymentComponentScore(20, 8),
      reviewScore: reviewComponentScore(6, 4.5),
      voteScore: voteComponentScore(15, 1),
      tenureScore: 200 / 365,
    });
    // 0.4*0.80 + 0.3*0.78 + 0.2*0.75 + 0.1*0.548 = 0.32+0.234+0.15+0.0548 = 0.7588 -> 76
    expect(score).toBe(76);
  });
});

describe("fetchPaymentStats", () => {
  const payerA = "0x" + "11".repeat(20);
  const payerB = "0x" + "22".repeat(20);
  const topicFor = (addr: string) => "0x" + "00".repeat(12) + addr.slice(2);

  function mockFetch(pages: Array<{ logs: Array<{ topics: string[]; data: string }>; next?: string | null }>) {
    let calls = 0;
    const impl = vi.fn(async () => {
      const page = pages[Math.min(calls, pages.length - 1)];
      calls += 1;
      return {
        ok: true,
        json: async () => ({ logs: page.logs, links: { next: page.next ?? null } }),
      } as unknown as Response;
    });
    return { impl, calls: () => calls };
  }

  const logFor = (payer: string, username = "someagent") => ({
    topics: [
      ethers.id("TipSent(string,address,address,uint256,uint256)"),
      ethers.keccak256(ethers.toUtf8Bytes(username)),
      topicFor(payer),
    ],
    data: "0x" + "00".repeat(64), // amount + fee (not needed for counting)
  });

  it("counts txs and unique payers across pages", async () => {
    const { impl } = mockFetch([
      { logs: [logFor(payerA), logFor(payerB), logFor(payerA)], next: "/page2" },
      { logs: [logFor(payerB)], next: null },
    ]);
    const stats = await fetchPaymentStats("someagent", impl as unknown as typeof fetch);
    expect(stats.txCount).toBe(4);
    expect(stats.uniquePayers).toBe(2);
  });

  it("returns zeros when there are no logs", async () => {
    const { impl } = mockFetch([{ logs: [], next: null }]);
    const stats = await fetchPaymentStats("newagent", impl as unknown as typeof fetch);
    expect(stats).toEqual({ txCount: 0, uniquePayers: 0 });
  });

  it("skips malformed logs instead of crashing", async () => {
    const { impl } = mockFetch([{ logs: [{ topics: ["0x1234"], data: "0x" }], next: null }]);
    const stats = await fetchPaymentStats("someagent", impl as unknown as typeof fetch);
    expect(stats).toEqual({ txCount: 0, uniquePayers: 0 });
  });

  it("filters by event signature and username topic in code", async () => {
    const otherUserTopic = ethers.keccak256(ethers.toUtf8Bytes("otheragent"));
    const otherEventLog = {
      topics: ["0x" + "cc".repeat(32), "0x" + "bb".repeat(32), topicFor(payerA)],
      data: "0x" + "00".repeat(64),
    };
    const otherUserLog = {
      topics: [
        ethers.id("TipSent(string,address,address,uint256,uint256)"),
        otherUserTopic,
        topicFor(payerA),
      ],
      data: "0x" + "00".repeat(64),
    };
    const { impl } = mockFetch([
      { logs: [logFor(payerA), otherEventLog, otherUserLog], next: null },
    ]);
    const stats = await fetchPaymentStats("someagent", impl as unknown as typeof fetch);
    // only the one genuine TipSent-for-someagent log counts
    expect(stats).toEqual({ txCount: 1, uniquePayers: 1 });
  });
});

describe("computeTrustScore", () => {
  const emptyFetch = async () =>
    ({ ok: true, json: async () => ({ logs: [], links: { next: null } }) }) as unknown as Response;

  it("returns null score with honest note when there is no signal at all", async () => {
    vi.stubGlobal("fetch", emptyFetch);
    const t = await computeTrustScore({
      username: "ghost",
      registeredAt: null,
      up: 0,
      down: 0,
      reviewCount: 0,
      reviewAvg: null,
    });
    expect(t.score).toBeNull();
    expect(t.basis).toBe("on-chain");
    expect(t.note).toMatch(/not enough data/i);
  });

  it("never throws when the mirror node is down", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("boom");
    });
    const t = await computeTrustScore({
      username: "ghost",
      registeredAt: null,
      up: 3,
      down: 0,
      reviewCount: 0,
      reviewAvg: null,
    });
    // votes alone are a signal -> numeric score, payments degrade to 0
    expect(t.score).not.toBeNull();
    expect(t.components.payments.txCount).toBe(0);
  });

  it("marks thin data as beta", async () => {
    vi.stubGlobal("fetch", emptyFetch);
    const t = await computeTrustScore({
      username: "newbie",
      registeredAt: null,
      up: 2,
      down: 0,
      reviewCount: 0,
      reviewAvg: null,
    });
    expect(t.score).not.toBeNull();
    expect(t.beta).toBe(true);
    expect(t.note).toMatch(/beta/i);
  });

  it("rich data is not beta and has no warning note", async () => {
    vi.stubGlobal("fetch", emptyFetch);
    const t = await computeTrustScore({
      username: "veteran",
      registeredAt: "1700000000.000000000",
      up: 30,
      down: 1,
      reviewCount: 12,
      reviewAvg: 4.8,
    });
    expect(t.beta).toBe(false);
    expect(t.note).toBeNull();
    expect(t.score).toBeGreaterThan(50);
  });

  it("caches per username for 15 minutes", async () => {
    const impl = vi.fn(emptyFetch);
    vi.stubGlobal("fetch", impl);
    const inputs = {
      username: "cached",
      registeredAt: null,
      up: 5,
      down: 0,
      reviewCount: 0,
      reviewAvg: null as number | null,
    };
    await computeTrustScore(inputs);
    await computeTrustScore(inputs);
    expect(impl).toHaveBeenCalledTimes(1);
  });
});
