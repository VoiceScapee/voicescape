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

describe("mirror catch-up signal", () => {
  it("parses the valid start from an @-form transaction id", async () => {
    const { parseTxValidStartMs } = await import("./tx-confirm");
    // 1000000000.5s -> 1000000000500 ms
    expect(parseTxValidStartMs("0.0.123@1000000000.500000000")).toBe(1000000000500);
    expect(parseTxValidStartMs("0.0.123@1000000000")).toBe(1000000000000);
  });

  it("returns null for ids with no parseable valid start — never a default signal", async () => {
    const { parseTxValidStartMs } = await import("./tx-confirm");
    expect(parseTxValidStartMs("0.0.123-1000000000-500000000")).toBeNull(); // dash form
    expect(parseTxValidStartMs("0xabcdef1234567890")).toBeNull(); // EVM hash
    expect(parseTxValidStartMs("not-a-tx-id")).toBeNull();
  });

  it("reads the mirror index frontier from the newest block", async () => {
    const { getMirrorHeadTimestampMs } = await import("./tx-confirm");
    mockFetchSequence([
      {
        ok: true,
        body: { blocks: [{ timestamp: { from: "1789520000.000000000", to: "1789520060.250000000" } }] },
      },
    ]);
    // 1789520060.25s -> ms
    expect(await getMirrorHeadTimestampMs()).toBe(1789520060250);
  });

  it("returns null (no signal) when the blocks endpoint fails", async () => {
    const { getMirrorHeadTimestampMs } = await import("./tx-confirm");
    mockFetchSequence([{ ok: false }]);
    expect(await getMirrorHeadTimestampMs()).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await getMirrorHeadTimestampMs()).toBeNull();
  });

  it("only declares the window passed when the frontier is beyond valid start + margin", async () => {
    const { isMirrorBeyondTxWindow } = await import("./tx-confirm");
    const txId = "0.0.123@1000000000.000000000"; // valid start = 1000000000000 ms
    const margin = 60_000;
    expect(isMirrorBeyondTxWindow(txId, 1000000060000, margin)).toBe(true); // exactly at the edge
    expect(isMirrorBeyondTxWindow(txId, 1000000120000, margin)).toBe(true);
    expect(isMirrorBeyondTxWindow(txId, 1000000059999, margin)).toBe(false); // mirror still behind
    expect(isMirrorBeyondTxWindow(txId, null, margin)).toBe(false); // no signal -> never final
    expect(isMirrorBeyondTxWindow("0xdeadbeef", 1000000120000, margin)).toBe(false); // unparseable -> never final
  });

  it("poll returns expired when the mirror has indexed past the tx window and the tx never appeared", async () => {
    const headTo = "1000000120.000000000"; // 1000000120000 ms
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/blocks")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ blocks: [{ timestamp: { to: headTo } }] }),
          });
        }
        return Promise.resolve({ ok: false }); // tx never indexed
      }),
    );
    const outcome = await pollTransactionStatus("0.0.123@1000000000.000000000", {
      timeoutMs: 5000,
      baseDelayMs: 5,
      maxDelayMs: 10,
      catchUpMarginMs: 60_000, // window ends at 1000000060000 < head 1000000120000
    });
    expect(outcome).toBe("expired");
  });

  it("poll keeps unknown-as-timeout when the mirror has NOT caught up", async () => {
    const headTo = "1000000005.000000000"; // head still inside the window
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/blocks")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ blocks: [{ timestamp: { to: headTo } }] }),
          });
        }
        return Promise.resolve({ ok: false });
      }),
    );
    const outcome = await pollTransactionStatus("0.0.123@1000000000.000000000", {
      timeoutMs: 60,
      baseDelayMs: 5,
      maxDelayMs: 10,
      catchUpMarginMs: 60_000,
    });
    // Never misreported as expired — the mirror may just be behind.
    expect(outcome).toBe("timeout");
  });

  it("poll with catchUpMarginMs 0 disables the check — missing txs only time out", async () => {
    const headTo = "1000000999.000000000"; // far past the window
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/blocks")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ blocks: [{ timestamp: { to: headTo } }] }),
          });
        }
        return Promise.resolve({ ok: false });
      }),
    );
    const outcome = await pollTransactionStatus("0.0.123@1000000000.000000000", {
      timeoutMs: 60,
      baseDelayMs: 5,
      maxDelayMs: 10,
      catchUpMarginMs: 0,
    });
    expect(outcome).toBe("timeout");
  });
});
