import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffDelayMs, fetchMirrorWithRetry } from "./fetch-retry";

function okResponse(status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}) } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("backoffDelayMs", () => {
  it("grows exponentially with the attempt number", () => {
    // Jitter adds up to baseMs, so compare ranges.
    const d0 = backoffDelayMs(0, 500);
    const d1 = backoffDelayMs(1, 500);
    const d2 = backoffDelayMs(2, 500);
    expect(d0).toBeGreaterThanOrEqual(500);
    expect(d0).toBeLessThan(1000);
    expect(d1).toBeGreaterThanOrEqual(1000);
    expect(d1).toBeLessThan(1500);
    expect(d2).toBeGreaterThanOrEqual(2000);
    expect(d2).toBeLessThan(2500);
  });
});

describe("fetchMirrorWithRetry", () => {
  it("returns a successful response without retrying", async () => {
    const fetchMock = vi.fn(async () => okResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchMirrorWithRetry("https://example.com");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(okResponse(429))
      .mockResolvedValueOnce(okResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    const p = fetchMirrorWithRetry("https://example.com", { baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries on persistent 429", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => okResponse(429));
    vi.stubGlobal("fetch", fetchMock);
    const p = fetchMirrorWithRetry("https://example.com", {
      maxRetries: 2,
      baseDelayMs: 10,
    });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(429);
    // 1 initial + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry other 4xx responses", async () => {
    const fetchMock = vi.fn(async () => okResponse(404));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchMirrorWithRetry("https://example.com");
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls on 404 when indexingWaitAttempts is set", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(okResponse(404))
      .mockResolvedValueOnce(okResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    const p = fetchMirrorWithRetry("https://example.com", {
      indexingWaitAttempts: 3,
      indexingWaitDelayMs: 10,
      baseDelayMs: 10,
    });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the 404 after exhausting indexing-wait attempts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => okResponse(404));
    vi.stubGlobal("fetch", fetchMock);
    const p = fetchMirrorWithRetry("https://example.com", {
      indexingWaitAttempts: 2,
      indexingWaitDelayMs: 10,
      baseDelayMs: 10,
    });
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(404);
    // 1 initial + 2 indexing-wait polls
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
