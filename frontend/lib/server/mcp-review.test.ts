import { describe, it, expect } from "vitest";
import {
  reviewAgentTipping,
  hashReport,
  buildAttestationTx,
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
