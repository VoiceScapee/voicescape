/**
 * Tests for the reactive post-transaction confirmation poller.
 *
 * The poller asks the mirror node for a transaction's result until it is
 * SUCCESS (confirmed), some other terminal result (failed), or the cap
 * elapses (timeout — never misreported as failure).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { pollTransactionStatus, consensusTimestampToDate } from "./tx-confirm";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetchSequence(responses: Array<{ ok: boolean; body?: unknown }>) {
  const queue = responses.map(({ ok, body }) => ({
    ok,
    json: async () => body ?? {},
  }));
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => queue.shift() ?? queue[queue.length - 1]));
}

describe("pollTransactionStatus", () => {
  it("returns confirmed when the mirror node reports SUCCESS", async () => {
    mockFetchSequence([{ ok: true, body: { transactions: [{ result: "SUCCESS" }] } }]);
    const outcome = await pollTransactionStatus("0.0.10424063-1789255516-411663562", {
      timeoutMs: 1000,
      baseDelayMs: 5,
    });
    expect(outcome).toBe("confirmed");
  });

  it("returns failed when the transaction reverted on-chain", async () => {
    mockFetchSequence([
      { ok: true, body: { transactions: [{ result: "CONTRACT_REVERT_EXECUTED" }] } },
    ]);
    const outcome = await pollTransactionStatus("0.0.10425049-1789252298-845089138", {
      timeoutMs: 1000,
      baseDelayMs: 5,
    });
    expect(outcome).toBe("failed");
  });

  it("keeps polling through 404s and confirms once the result appears", async () => {
    mockFetchSequence([
      { ok: false },
      { ok: true, body: { transactions: [] } },
      { ok: true, body: { transactions: [{ result: "SUCCESS" }] } },
    ]);
    const outcome = await pollTransactionStatus("0.0.10424063-1789255516-411663562", {
      timeoutMs: 5000,
      baseDelayMs: 5,
      maxDelayMs: 10,
    });
    expect(outcome).toBe("confirmed");
    expect(vi.mocked(fetch).mock.calls.length).toBe(3);
  });

  it("survives network errors and confirms on a later attempt", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("network down"));
        return Promise.resolve({
          ok: true,
          json: async () => ({ transactions: [{ result: "SUCCESS" }] }),
        });
      }),
    );
    const outcome = await pollTransactionStatus("0.0.10424063-1789255516-411663562", {
      timeoutMs: 5000,
      baseDelayMs: 5,
      maxDelayMs: 10,
    });
    expect(outcome).toBe("confirmed");
  });

  it("returns timeout (not failed) when the cap elapses with no result", async () => {
    mockFetchSequence([{ ok: false }]);
    const outcome = await pollTransactionStatus("0.0.10424063-1789255516-411663562", {
      timeoutMs: 30,
      baseDelayMs: 5,
      maxDelayMs: 10,
    });
    expect(outcome).toBe("timeout");
  });

  it("URL-encodes the transaction id", async () => {
    mockFetchSequence([{ ok: true, body: { transactions: [{ result: "SUCCESS" }] } }]);
    await pollTransactionStatus("0.0.10424063-1789255516-411663562", { timeoutMs: 1000 });
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toContain("/transactions/0.0.10424063-1789255516-411663562");
  });

  it("rejects when aborted", async () => {
    mockFetchSequence([{ ok: false }]);
    const controller = new AbortController();
    const pending = pollTransactionStatus("0.0.10424063-1789255516-411663562", {
      timeoutMs: 5000,
      baseDelayMs: 50,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
});

describe("finality formatting", () => {
  it("formats elapsed milliseconds as seconds with one decimal", async () => {
    const { formatFinalitySecs, formatFinalizedAt } = await import("./tx-confirm");
    expect(formatFinalitySecs(16442)).toBe("16.4 seconds");
    expect(formatFinalitySecs(0)).toBe("0.0 seconds");
    expect(formatFinalitySecs(-50)).toBe("0.0 seconds");
  });

  it("formats the exact local confirmation time with seconds", async () => {
    const { formatFinalizedAt } = await import("./tx-confirm");
    const d = new Date(2026, 8, 12, 19, 40, 50);
    expect(formatFinalizedAt(d)).toMatch(/7:40:50/);
  });
});

describe("toMirrorTxId", () => {
  it("converts the wallet @ form to the mirror's dash form", async () => {
    const { toMirrorTxId } = await import("./tx-confirm");
    expect(toMirrorTxId("0.0.10857409@1789339017.871111290")).toBe(
      "0.0.10857409-1789339017-871111290",
    );
  });

  it("passes dash-form ids and EVM hashes through untouched", async () => {
    const { toMirrorTxId } = await import("./tx-confirm");
    expect(toMirrorTxId("0.0.10424063-1789255516-411663562")).toBe(
      "0.0.10424063-1789255516-411663562",
    );
    expect(toMirrorTxId("0xabc123")).toBe("0xabc123");
  });
});

describe("pollTransactionStatus wallet txId regression", () => {
  it("queries the mirror with dashes when given a wallet @-form txId", async () => {
    mockFetchSequence([{ ok: true, body: { transactions: [{ result: "SUCCESS" }] } }]);
    const outcome = await pollTransactionStatus("0.0.10857409@1789339017.871111290", {
      timeoutMs: 1000,
      baseDelayMs: 5,
    });
    expect(outcome).toBe("confirmed");
    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url).toContain("0.0.10857409-1789339017-871111290");
    expect(url).not.toContain("@");
  });
});

describe("consensusTimestampToDate", () => {
  it("parses a mirror-node seconds.nanos timestamp without float rounding", () => {
    // parseFloat("1789520539.844492534") rounds the nanos; string-splitting
    // must not shift the second.
    const d = consensusTimestampToDate("1789520539.844492534");
    expect(d).not.toBeNull();
    expect(d!.getTime()).toBe(1789520539 * 1000 + 844);
  });

  it("handles whole-second timestamps", () => {
    expect(consensusTimestampToDate("1789520539")!.getTime()).toBe(1789520539 * 1000);
  });

  it("returns null for garbage", () => {
    expect(consensusTimestampToDate("")).toBeNull();
    expect(consensusTimestampToDate("not-a-time")).toBeNull();
  });
});

describe("pollTransactionStatus onConsensus", () => {
  it("passes the mirror consensus_timestamp to the callback on confirm", async () => {
    mockFetchSequence([
      { ok: true, body: { transactions: [{ result: "SUCCESS", consensus_timestamp: "1789520539.844492534" }] } },
    ]);
    let seen: string | null = "unset";
    const outcome = await pollTransactionStatus("0.0.1-1789520539-844492534", {
      timeoutMs: 1000,
      baseDelayMs: 5,
      onConsensus: (ts) => {
        seen = ts;
      },
    });
    expect(outcome).toBe("confirmed");
    expect(seen).toBe("1789520539.844492534");
  });

  it("passes null when the mirror omits the timestamp", async () => {
    mockFetchSequence([{ ok: true, body: { transactions: [{ result: "SUCCESS" }] } }]);
    let seen: string | null = "unset";
    await pollTransactionStatus("0.0.1-1789520539-844492534", {
      timeoutMs: 1000,
      baseDelayMs: 5,
      onConsensus: (ts) => {
        seen = ts;
      },
    });
    expect(seen).toBeNull();
  });
});
