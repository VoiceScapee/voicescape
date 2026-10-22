import { describe, expect, it, vi } from "vitest";
import { fetchMirrorWithRetry } from "./fetch-mirror";

function statusResponse(status: number, body: unknown = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

describe("fetchMirrorWithRetry", () => {
  it("retries 429s and then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(statusResponse(429))
      .mockResolvedValueOnce(statusResponse(200, { ok: true }));
    const res = await fetchMirrorWithRetry("https://mirror.example.test/x", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseDelayMs: 1,
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting retries on network errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(
      fetchMirrorWithRetry("https://mirror.example.test/x", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        maxRetries: 1,
        baseDelayMs: 1,
      }),
    ).rejects.toThrow("down");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns non-429 errors immediately without retry", async () => {
    const fetchImpl = vi.fn(async () => statusResponse(500));
    const res = await fetchMirrorWithRetry("https://mirror.example.test/x", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseDelayMs: 1,
    });
    expect(res.status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns 404 immediately when no indexing wait is configured", async () => {
    const fetchImpl = vi.fn(async () => statusResponse(404));
    const res = await fetchMirrorWithRetry("https://mirror.example.test/x", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseDelayMs: 1,
    });
    expect(res.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
