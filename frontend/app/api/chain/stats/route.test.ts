/**
 * GET /api/chain/stats tests: selector derivation, paginated counting with
 * per-page success/selector filtering, 15-minute module cache, and the
 * fail-soft contract (any error → 200 { pages: null, tips: null }, never 500).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const REGISTRY_RESULTS_1 = "/api/v1/contracts/0.0.10854058/results";
const TIPS_RESULTS_1 = "/api/v1/contracts/0.0.10854060/results";

function page(
  results: Array<{ error_message?: string | null; function_parameters?: string | null }>,
  next: string | null,
): Response {
  return new Response(JSON.stringify({ results, links: { next } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Mirror stub: registry has 2 successful registerPage calls spread over two
 * pages (plus noise that must NOT count — a wrong-selector success and a
 * reverted registerPage); tips has 3 successful results on a single page.
 * Row shape matches the real mirror node: success = empty/missing
 * error_message, failure = non-empty error_message (revert data).
 */
function mirrorStub() {
  return vi.fn((url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("0.0.10854058")) {
      if (u.includes("timestamp=")) {
        return Promise.resolve(
          page(
            [
              { error_message: "", function_parameters: "0xc02fdb27aaaa" },
            ],
            null,
          ),
        );
      }
      return Promise.resolve(
        page(
          [
            { error_message: "", function_parameters: "0xc02fdb27dead" },
            // Wrong selector — a different Registry function call: excluded.
            { error_message: "", function_parameters: "0xdeadbeef1234" },
            // Reverted registerPage call: excluded (non-empty error_message).
            { error_message: "0x08c379a0", function_parameters: "0xc02fdb27beef" },
          ],
          `${REGISTRY_RESULTS_1}?limit=100&order=asc&timestamp=lt:1789500000.0`,
        ),
      );
    }
    if (u.includes("0.0.10854060")) {
      return Promise.resolve(
        page(
          [
            { error_message: "", function_parameters: "0x1111" },
            { error_message: "", function_parameters: "0x2222" },
            { error_message: null, function_parameters: "0x3333" },
            { error_message: "0x08c379a0", function_parameters: "0x4444" },
          ],
          null,
        ),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/chain/stats", () => {
  it("derives the registerPage selector (sanity: 0xc02fdb27)", async () => {
    const { REGISTER_PAGE_SELECTOR } = await import("@/lib/server/chain-stats");
    expect(REGISTER_PAGE_SELECTOR).toBe("0xc02fdb27");
  });

  it("counts paginated successful results, filtering registerPage selector on the Registry only", async () => {
    const fetchMock = mirrorStub();
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    const res = await GET();
    const json = (await res.json()) as { pages: number | null; tips: number | null };
    expect(res.status).toBe(200);
    // Registry: 2 successful registerPage calls across 2 pages (noise excluded).
    expect(json.pages).toBe(2);
    // Tips: 3 successful results (1 reverted excluded), selector filter off.
    expect(json.tips).toBe(3);
    // Both lanes paginate via contract results on the official mirror node.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("0.0.10854058"))).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("0.0.10854060"))).toBe(true);
  });

  it("caches for 15 minutes: a second GET inside the TTL makes no new mirror calls", async () => {
    const fetchMock = mirrorStub();
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    await GET();
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    await GET();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("fails soft on a transport error: 200 { pages: null, tips: null }, never 500", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pages: null, tips: null });
  });

  it("fails soft on mirror HTTP errors (non-2xx)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("bad", { status: 503 }))));
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pages: null, tips: null });
  });

  it("serves the stale cache when a refresh fails after the TTL lapses", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = mirrorStub();
      vi.stubGlobal("fetch", fetchMock);
      const { GET } = await import("./route");
      const first = await GET();
      const firstJson = (await first.json()) as { pages: number | null; tips: number | null };
      expect(firstJson.pages).toBe(2);
      // The TTL lapses, then the mirror goes down: the stale entry ships
      // instead of nulls.
      vi.advanceTimersByTime(16 * 60_000);
      vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));
      const second = await GET();
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual(firstJson);
    } finally {
      vi.useRealTimers();
    }
  });
});
