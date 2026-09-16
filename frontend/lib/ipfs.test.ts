import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchPageJson } from "./ipfs";

// Regression test for the /forge production hang (2026-09-16): a gateway
// that accepts the connection and then stalls must be skipped after the
// per-gateway timeout — the page must never sit on "Resolving … on-chain"
// forever with no error.

function hangingFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
    // Never resolves on its own — simulates a stalled gateway.
  });
}

function okFetch(body: string) {
  return async (): Promise<Response> =>
    ({ ok: true, text: async () => body }) as Response;
}

describe("fetchPageJson gateway timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("skips a stalled gateway and succeeds on the next one", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(hangingFetch)
      .mockImplementationOnce(okFetch('{"theme":{}}'));
    const pending = fetchPageJson("QmTestStalled");
    // Let the first gateway's 15s timeout fire, then settle.
    await vi.advanceTimersByTimeAsync(16_000);
    const text = await pending;
    expect(text).toBe('{"theme":{}}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws instead of hanging when every gateway stalls", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch);
    const pending = fetchPageJson("QmTestAllStalled");
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    // 3 gateways × 15s timeout.
    await vi.advanceTimersByTimeAsync(50_000);
    await assertion;
  });

  it("still surfaces non-timeout gateway failures as the last error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 429,
    } as Response);
    await expect(fetchPageJson("QmTest429")).rejects.toThrow(/429/);
  });
});
