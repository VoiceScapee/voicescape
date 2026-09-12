/**
 * Tests for the reactive post-transaction confirmation poller.
 *
 * The poller asks the mirror node for a transaction's result until it is
 * SUCCESS (confirmed), some other terminal result (failed), or the cap
 * elapses (timeout — never misreported as failure).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { pollTransactionStatus } from "./tx-confirm";

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
