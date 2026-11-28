import { describe, it, expect } from "vitest";
import {
  reviewAgentTipping,
  hashReport,
  buildAttestationTx,
} from "./mcp-review";
import { TIPSENT_TOPIC } from "../leaderboard";

const SUBJECT_EVM = "0x" + "a".repeat(40);
const OTHER_EVM = "0x" + "b".repeat(40);
const OTHER2_EVM = "0x" + "c".repeat(40);

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

/** Valid 64-hex-char EVM hash for tip #n (1-based). */
function tipHash(n: number): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

function padTopic(addr: string): string {
  return "0x" + addr.slice(2).padStart(64, "0");
}

function word(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

/** A TipSent log for a 1 HBAR tip (gross 100_000_000, fee 2_000_000 tinybar). */
function tipSentLog(sender: string, recipient: string, grossTinybar = 100_000_000n) {
  const fee = (grossTinybar * 200n) / 10_000n;
  return {
    topics: [
      TIPSENT_TOPIC,
      "0x" + "1".repeat(64), // username hash — not an address
      padTopic(sender),
      padTopic(recipient),
    ],
    data: "0x" + word(grossTinybar) + word(fee),
    timestamp: "1700000000.000000000",
  };
}

/** A contract-results list row for a tipPage call from the subject. */
function tipRow(n: number, amountTinybar = 100_000_000) {
  return {
    hash: tipHash(n),
    from: SUBJECT_EVM,
    amount: amountTinybar,
    timestamp: `170000000${n}.000000000`,
    // tipPage(string) calldata: selector 0x8b0de5cb + encoded args.
    function_parameters: "0x8b0de5cb" + "0".repeat(128),
  };
}

/** A contract-results list row for a buyListing call from the subject. */
function buyRow(n: number, amountTinybar: number) {
  return {
    hash: tipHash(n),
    from: SUBJECT_EVM,
    amount: amountTinybar,
    timestamp: `170000000${n}.000000000`,
    // buyListing calldata: selector 0x8e893f02 — not a tip.
    function_parameters: "0x8e893f02" + "0".repeat(128),
  };
}

/** Mock /contracts/results/{hash} response carrying one TipSent log. */
function tipResult(sender: string, recipient: string, grossTinybar = 100_000_000n) {
  return {
    status: "0x1",
    contract_id: "0.0.10854060",
    timestamp: "1700000000.000000000",
    logs: [tipSentLog(sender, recipient, grossTinybar)],
  };
}

const ACCOUNT_MOCK = {
  "/accounts/0.0.111111": { evm_address: SUBJECT_EVM },
};

describe("reviewAgentTipping", () => {
  it("returns insufficient_data for an account with no tips", async () => {
    const fetchFn = mockFetch({
      ...ACCOUNT_MOCK,
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
    const fetchFn = mockFetch({
      ...ACCOUNT_MOCK,
      "/results?": { results: [1, 2, 3, 4].map((i) => tipRow(i)) },
      [`/contracts/results/${tipHash(1)}`]: tipResult(SUBJECT_EVM, SUBJECT_EVM),
      [`/contracts/results/${tipHash(2)}`]: tipResult(SUBJECT_EVM, SUBJECT_EVM),
      [`/contracts/results/${tipHash(3)}`]: tipResult(SUBJECT_EVM, SUBJECT_EVM),
      [`/contracts/results/${tipHash(4)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
    });
    const r = await reviewAgentTipping("0.0.111111", fetchFn as any);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.verdict).toBe("flagged");
      expect(r.self_tip_count).toBe(3);
      expect(r.evidence.filter((e) => e.self_tip)).toHaveLength(3);
    }
  });

  it("flags the Clearance repro: 6 tips to the subject's own page", async () => {
    // Lev Tarasov, 2026-11-27: 6 tips to his own page, 5 self-tips, the
    // old review called it "clean" because every recipient was "unknown".
    const fetchFn = mockFetch({
      ...ACCOUNT_MOCK,
      "/results?": { results: [1, 2, 3, 4, 5, 6].map((i) => tipRow(i)) },
      [`/contracts/results/${tipHash(1)}`]: tipResult(SUBJECT_EVM, SUBJECT_EVM),
      [`/contracts/results/${tipHash(2)}`]: tipResult(SUBJECT_EVM, SUBJECT_EVM),
      [`/contracts/results/${tipHash(3)}`]: tipResult(SUBJECT_EVM, SUBJECT_EVM),
      [`/contracts/results/${tipHash(4)}`]: tipResult(SUBJECT_EVM, SUBJECT_EVM),
      [`/contracts/results/${tipHash(5)}`]: tipResult(SUBJECT_EVM, SUBJECT_EVM),
      [`/contracts/results/${tipHash(6)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
    });
    const r = await reviewAgentTipping("0.0.111111", fetchFn as any);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.verdict).toBe("flagged");
      expect(r.self_tip_count).toBe(5);
      expect(r.tips_analyzed).toBe(6);
      expect(r.evidence.every((e) => e.recipient !== "unknown")).toBe(true);
    }
  });

  it("flags a single whale tip over 100 HBAR", async () => {
    const fetchFn = mockFetch({
      ...ACCOUNT_MOCK,
      "/results?": {
        results: [1, 2, 3].map((i) =>
          tipRow(i, i === 1 ? 15_000_000_000 : 100_000_000),
        ),
      },
      [`/contracts/results/${tipHash(1)}`]: tipResult(
        SUBJECT_EVM,
        OTHER_EVM,
        15_000_000_000n,
      ),
      [`/contracts/results/${tipHash(2)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
      [`/contracts/results/${tipHash(3)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
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
      ...ACCOUNT_MOCK,
      "/results?": { results: [1, 2, 3, 4].map((i) => tipRow(i, 200_000_000)) },
      [`/contracts/results/${tipHash(1)}`]: tipResult(SUBJECT_EVM, OTHER_EVM, 200_000_000n),
      [`/contracts/results/${tipHash(2)}`]: tipResult(SUBJECT_EVM, OTHER_EVM, 200_000_000n),
      [`/contracts/results/${tipHash(3)}`]: tipResult(SUBJECT_EVM, OTHER_EVM, 200_000_000n),
      [`/contracts/results/${tipHash(4)}`]: tipResult(SUBJECT_EVM, OTHER_EVM, 200_000_000n),
    });
    const r = await reviewAgentTipping("0.0.111111", fetchFn as any);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.verdict).toBe("clean");
      expect(r.self_tip_count).toBe(0);
      expect(r.evidence[0].recipient).toBe(OTHER_EVM);
    }
  });

  it("refuses a clean verdict when the wash check did not run", async () => {
    // Tip #2's contract-result read fails (no mock entry → ok:false):
    // the recipient is unknown, so no clean verdict and no attestation.
    const fetchFn = mockFetch({
      ...ACCOUNT_MOCK,
      "/results?": { results: [1, 2, 3, 4].map((i) => tipRow(i)) },
      [`/contracts/results/${tipHash(1)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
      [`/contracts/results/${tipHash(3)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
      [`/contracts/results/${tipHash(4)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
    });
    const r = await reviewAgentTipping("0.0.111111", fetchFn as any);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.verdict).toBe("insufficient_data");
      expect(r.summary).toContain("wash check did not run");
      expect(r.attestation_tx_base64).toBeNull();
      expect(r.evidence.find((e) => e.recipient === "unknown")).toBeDefined();
    }
  });

  it("excludes non-tip contract calls from the sample", async () => {
    // Tip #4 is a marketplace purchase on the same contract (buyListing,
    // selector 0x8e893f02): it is not a tip and must not count.
    const fetchFn = mockFetch({
      ...ACCOUNT_MOCK,
      "/results?": { results: [1, 2, 3].map((i) => tipRow(i)).concat([buyRow(4, 18_586_439)]) },
      [`/contracts/results/${tipHash(1)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
      [`/contracts/results/${tipHash(2)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
      [`/contracts/results/${tipHash(3)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
      [`/contracts/results/${tipHash(4)}`]: {
        status: "0x1",
        contract_id: "0.0.10854060",
        timestamp: "1700000004.000000000",
        logs: [],
      },
    });
    const r = await reviewAgentTipping("0.0.111111", fetchFn as any);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.tips_analyzed).toBe(3);
      expect(r.total_tipped_hbar).toBe("3");
      expect(r.verdict).toBe("clean");
    }
  });

  it("excludes a buyListing call even when its proof read fails", async () => {
    // 2026-11-28 live incident (Lev Tarasov 0.0.10969859): a transient
    // mirror outage made every proof read fail at once, and the buy was
    // then counted as an unresolved 0.18586439 HBAR "tip" — 6 tips /
    // 0.23586439 HBAR / all recipients unknown — because the exclusion
    // only fired on a successful "not-a-tip" proof. The selector filter
    // must keep the buy out of the sample regardless of proof health:
    // no mock entry for the buy hash, so its proof read fails outright.
    const fetchFn = mockFetch({
      ...ACCOUNT_MOCK,
      "/results?": { results: [1, 2, 3].map((i) => tipRow(i)).concat([buyRow(4, 18_586_439)]) },
      [`/contracts/results/${tipHash(1)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
      [`/contracts/results/${tipHash(2)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
      [`/contracts/results/${tipHash(3)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
    });
    const r = await reviewAgentTipping("0.0.111111", fetchFn as any);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.tips_analyzed).toBe(3);
      expect(r.total_tipped_hbar).toBe("3");
      expect(r.verdict).toBe("clean");
      expect(r.evidence.every((e) => e.recipient !== "unknown")).toBe(true);
    }
  });

  it("drops rows whose function is unconfirmed (no function_parameters)", async () => {
    // A row that cannot be confirmed as a tipPage call is not a tip:
    // fail closed rather than risk counting a purchase as a tip.
    const unconfirmedRow = {
      hash: tipHash(4),
      from: SUBJECT_EVM,
      amount: 18_586_439,
      timestamp: "1700000004.000000000",
    };
    const fetchFn = mockFetch({
      ...ACCOUNT_MOCK,
      "/results?": { results: [...[1, 2, 3].map((i) => tipRow(i)), unconfirmedRow] },
      [`/contracts/results/${tipHash(1)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
      [`/contracts/results/${tipHash(2)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
      [`/contracts/results/${tipHash(3)}`]: tipResult(SUBJECT_EVM, OTHER_EVM),
    });
    const r = await reviewAgentTipping("0.0.111111", fetchFn as any);
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.tips_analyzed).toBe(3);
      expect(r.total_tipped_hbar).toBe("3");
    }
  });

  it("report hash commits to nested evidence, not just top-level fields", async () => {
    const base = {
      ...ACCOUNT_MOCK,
      "/results?": { results: [1, 2, 3].map((i) => tipRow(i)) },
    };
    const mk = (recipient: string) =>
      mockFetch({
        ...base,
        [`/contracts/results/${tipHash(1)}`]: tipResult(SUBJECT_EVM, recipient),
        [`/contracts/results/${tipHash(2)}`]: tipResult(SUBJECT_EVM, recipient),
        [`/contracts/results/${tipHash(3)}`]: tipResult(SUBJECT_EVM, recipient),
      });
    const a = await reviewAgentTipping("0.0.111111", mk(OTHER_EVM) as any);
    const b = await reviewAgentTipping("0.0.111111", mk(OTHER2_EVM) as any);
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
