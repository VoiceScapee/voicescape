/**
 * fetchWithTimeout tests — the shared timeout wrapper for user-visible fetches.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchWithTimeout } from "./fetch-timeout";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWithTimeout", () => {
  it("resolves with the response when the fetch is fast", async () => {
    const res = new Response("ok");
    vi.stubGlobal("fetch", vi.fn(async () => res));
    await expect(fetchWithTimeout("https://example.com", 1000)).resolves.toBe(res);
  });

  it("rejects with AbortError when the fetch hangs past the timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const err = await fetchWithTimeout("https://example.com", 20).catch((e) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
  });

  it("passes the timeout signal through to fetch", async () => {
    let seenSignal: AbortSignal | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seenSignal = init?.signal ?? null;
        return new Response("ok");
      }),
    );
    await fetchWithTimeout("https://example.com", 1000);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });
});
