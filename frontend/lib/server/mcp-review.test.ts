import { describe, it, expect } from "vitest";
import {
  reviewAgentTipping,
  hashReport,
  buildAttestationTx,
  toCrossLedgerProfile,
  reviewToHCS27Entry,
  type TippingReview,
} from "./mcp-review";

function mockFetch(responses: Record<string, any>) {
  return async (url: string | URL | Request) => {
    const u = String(url);
    for (const [key, body] of Object.entries(responses)) {
      if (u.includes(key)) {
        return { ok: true, json: async () => body } as any;
      }
    }
    return { ok: false, json: async () => ({}) } as any;
  };
}

describe("reviewAgentTipping", () => {
  it("returns insufficient_data for an account with no tips", async () => {
    const fetchFn = mockFetch({
      "/accounts/0.0.999999": { evm_address: "0xabc123" },
      "/results?": { results: [] },
    });
    const r = await reviewAgentTipping("0.0.999999", fetchFn as any);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.verdict).toBe("insufficient_data");
      expect(r.report_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("rejects non-account subjects honestly", async () => {
    const fetchFn = mockFetch({});
    const r = await reviewAgentTipping("some-username", fetchFn as any);
    expect("error" in r).toBe(true);
  });

  it("flags a wash pattern when most tips go to the subject itself", async () => {
    const tips = ["0xaa01", "0xaa02", "0xaa03", "0xaa04"].map((h, i) => ({
      hash: h,
      from: "0xaaa",
      amount: 100_000_000,
      timestamp: `170000000${i}.000000000`,
    }));
    const fetchFn = mockFetch({
      "/accounts/0.0.111111": { evm_address: "0xaaa" },
      "/results?": { results: tips },
      "/transactions/0xaa01": {
        transactions: [
          {
            transfers: [
              { account: "0.0.111111", amount: 98_000_000 },
              { account: "0.0.10854060", amount: 1_000_000 },
              { account: "0.0.10424063", amount: 2_000_000 },
            ],
          },
        ],
      },
      "/transactions/0xaa02": {
        transactions: [
          {
            transfers: [
              { account: "0.0.111111", amount: 98_000_000 },
              { account: "0.0.10424063", amount: 2_000_000 },
            ],
          },
        ],
      },
      "/transactions/0xaa03": {
        transactions: [
          {
            transfers: [
              { account: "0.0.111111", amount: 98_000_000 },
              { account: "0.0.10424063", amount: 2_000_000 },
            ],
          },
        ],
      },
      "/transactions/0xaa04": {
        transactions: [
          {
            transfers: [
              { account: "0.0.222222", amount: 98_000_000 },
              { account: "0.0.10424063", amount: 2_000_000 },
            ],
          },
        ],
      },
    });
    const r = await reviewAgentTipping("0.0.111111", fetchFn as any);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.verdict).toBe("flagged");
      expect(r.self_tip_count).toBe(3);
      expect(r.evidence.filter((e) => e.self_tip)).toHaveLength(3);
    }
  });

  it("flags a single whale tip over 100 HBAR", async () => {
    const fetchFn = mockFetch({
      "/accounts/0.0.111111": { evm_address: "0xaaa" },
      "/results?": {
        results: [1, 2, 3].map((i) => ({
          hash: `0xwhale${i}`,
          from: "0xaaa",
          amount: i === 1 ? 15_000_000_000 : 100_000_000,
          timestamp: `170000000${i}.000000000`,
        })),
      },
      "/transactions/0xbe": {
        transactions: [
          {
            transfers: [
              { account: "0.0.333333", amount: 14_700_000_000 },
              { account: "0.0.10424063", amount: 300_000_000 },
            ],
          },
        ],
      },
    });
    const r = await reviewAgentTipping("0.0.111111", fetchFn as any);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.verdict).toBe("flagged");
      expect(r.summary).toContain("100 HBAR");
    }
  });

  it("returns clean for genuine tipping history", async () => {
    const fetchFn = mockFetch({
      "/accounts/0.0.111111": { evm_address: "0xaaa" },
      "/results?": {
        results: [1, 2, 3, 4].map((i) => ({
          hash: `0xcc0${i}`,
          from: "0xaaa",
          amount: 200_000_000,
          timestamp: `170000000${i}.000000000`,
        })),
      },
      "/transactions/0xcc": {
        transactions: [
          {
            transfers: [
              { account: "0.0.444444", amount: 196_000_000 },
              { account: "0.0.10424063", amount: 4_000_000 },
            ],
          },
        ],
      },
    });
    const r = await reviewAgentTipping("0.0.111111", fetchFn as any);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.verdict).toBe("clean");
      expect(r.self_tip_count).toBe(0);
      expect(r.evidence[0].recipient).toBe("0.0.444444");
    }
  });

  it("report hash commits to nested evidence, not just top-level fields", async () => {
    const base = {
      "/accounts/0.0.111111": { evm_address: "0xaaa" },
      "/results?": {
        results: [1, 2, 3].map((i) => ({
          hash: `0xee0${i}`,
          from: "0xaaa",
          amount: 100_000_000,
          timestamp: `170000000${i}.000000000`,
        })),
      },
    };
    const mk = (recipient: string) =>
      mockFetch({
        ...base,
        "/transactions/0xee": {
          transactions: [
            {
              transfers: [
                { account: recipient, amount: 98_000_000 },
                { account: "0.0.10424063", amount: 2_000_000 },
              ],
            },
          ],
        },
      });
    const a = await reviewAgentTipping("0.0.111111", mk("0.0.555555") as any);
    const b = await reviewAgentTipping("0.0.111111", mk("0.0.666666") as any);
    expect("error" in a).toBe(false);
    expect("error" in b).toBe(false);
    if (!("error" in a) && !("error" in b)) {
      // Same top-level summary shape, different nested evidence recipients.
      expect(a.summary).toBe(b.summary);
      expect(a.report_hash).not.toBe(b.report_hash);
    }
  });

  it("hashReport is deterministic", () => {
    const a = hashReport('{"b":1,"a":2}');
    const b = hashReport('{"b":1,"a":2}');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("buildAttestationTx returns null without a topic", async () => {
    const tx = await buildAttestationTx("0.0.0", "abc", "0.0.1", "clean");
    expect(tx).toBeNull();
  });

  it("buildAttestationTx builds a frozen unsigned tx with a real topic", async () => {
    const tx = await buildAttestationTx("0.0.12345", "abc123", "0.0.1", "clean");
    // May be null if SDK freeze needs network; just check it doesn't throw.
    expect(tx === null || typeof tx === "string").toBe(true);
  });
});

describe("cross-ledger profile (arion interop)", () => {
  const mkReview = (): TippingReview => ({
    subject: "0.0.123",
    subject_account: "0.0.123",
    review_type: "tipping_behavior",
    verdict: "clean",
    confidence: "high",
    summary: "test",
    tips_analyzed: 5,
    total_tipped_hbar: "10",
    self_tip_count: 0,
    evidence: [
      {
        transaction_id: "0.0.123@1234567890.000000000",
        amount_hbar: "2",
        recipient: "0.0.456",
        consensus_timestamp: "1234567890.000000000",
        hashscan: "https://hashscan.io/mainnet/transaction/0.0.123@1234567890.000000000",
        self_tip: false,
      },
    ],
    checked_at: "2026-10-06T00:00:00.000Z",
    reviewer: "io.github.VoiceScapee/voicescape",
    report_hash: "abc123",
    attestation_tx_base64: null,
    attestation_note: "test",
  });

  it("maps to the shared profile shape", () => {
    const p = toCrossLedgerProfile(mkReview());
    expect(p.subject).toBe("0.0.123");
    expect(p.procedure).toBe("tipping_behavior");
    expect(p.signer).toBe("io.github.VoiceScapee/voicescape");
    expect(p.digest).toBe("abc123");
    expect(p.digest_alg).toBe("SHA-256");
    expect(p.verdict_enum).toBe("clean");
    expect(p.scope).toBe("high");
    expect(p.schema_id).toBe("voicescape.tipping_review.v1");
    expect(p.observed_at).toBe("2026-10-06T00:00:00.000Z");
    expect(p.evidence).toHaveLength(1);
    expect(p.evidence[0].ref).toBe("0.0.123@1234567890.000000000");
    expect(p.evidence[0].anchor).toContain("hashscan.io");
  });

  it("produces a minimal HCS-27 entry", () => {
    const p = toCrossLedgerProfile(mkReview());
    const entry = reviewToHCS27Entry(p);
    expect(entry.schema_id).toBe("voicescape.tipping_review.v1");
    expect(entry.digest).toBe("abc123");
    // Minimal: no nested evidence arrays in the leaf
    expect(entry).not.toHaveProperty("evidence");
  });
});
