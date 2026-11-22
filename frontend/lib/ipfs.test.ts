import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchPageJson, MAX_PAGE_JSON_BYTES } from "./ipfs";

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

describe("fetchPageJson response size cap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a body whose Content-Length declares over the cap, without reading it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name === "content-length" ? String(MAX_PAGE_JSON_BYTES + 1) : null),
      },
    } as unknown as Response);
    await expect(fetchPageJson("QmTestCapLength")).rejects.toThrow(/too large/);
    // All three gateways were tried and each refused on the header alone.
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("refuses an oversize body read via text() (no stream available)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => "x".repeat(MAX_PAGE_JSON_BYTES + 1),
    } as unknown as Response);
    await expect(fetchPageJson("QmTestCapText")).rejects.toThrow(/too large/);
  });

  it("abandons a streaming body mid-read once it passes the cap", async () => {
    // Fresh stream per gateway attempt: a real fetch returns a new
    // Response each time, so the mock must too (a consumed stream
    // re-read on the next gateway would yield "" instead of the cap).
    const makeStream = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("x".repeat(MAX_PAGE_JSON_BYTES + 1)));
          c.close();
        },
      });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      headers: { get: () => null },
      body: makeStream(),
    }) as unknown as Response);
    await expect(fetchPageJson("QmTestCapStream")).rejects.toThrow(/too large/);
  });

  it("still returns a body under the cap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      text: async () => '{"theme":{}}',
    } as unknown as Response);
    await expect(fetchPageJson("QmTestCapOk")).resolves.toBe('{"theme":{}}');
  });

  it("skips a gateway that returns an empty body instead of serving it as JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      text: async () => "",
    } as unknown as Response);
    await expect(fetchPageJson("QmTestCapEmpty")).rejects.toThrow(/empty body/);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });
});
