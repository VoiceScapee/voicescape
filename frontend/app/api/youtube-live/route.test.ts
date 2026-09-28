/**
 * GET /api/youtube-live — honest-unknown contract.
 *
 * A failed server check (YouTube rate-limiting our IP, consent-wall page,
 * timeout, non-2xx) must return { ok: false } — NOT { ok: true, live: false }.
 * Clients hold their current player state on ok:false; claiming "offline" on
 * a flaky scrape is what was killing live playback (iframe src swap destroys
 * the player and its audio mid-listen).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

const CHANNEL = "UCtSk2QKfWVeKvVQTOCTBm1g";

function req(debug = false, channel = CHANNEL): NextRequest {
  return new NextRequest(
    `http://localhost/api/youtube-live?channel=${channel}${debug ? "&debug=1" : ""}`,
    { method: "GET" },
  );
}

/** Unique channel per test — the route caches per channel for 60s. */
let n = 0;
const freshChannel = () => `UC${String(n++).padStart(22, "0")}`;

const liveHtml = (videoId: string) =>
  `<html><head><link rel="canonical" href="https://www.youtube.com/watch?v=${videoId}"></head></html>`;

const offlineHtml = () =>
  `<html><head><link rel="canonical" href="https://www.youtube.com/channel/${CHANNEL}"></head></html>`;

function mockFetchOnce(impl: () => Promise<unknown>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/youtube-live — honest unknown", () => {
  it("returns ok:true + live:true + videoId when the /live page resolves to a video", async () => {
    mockFetchOnce(async () => ({
      ok: true,
      status: 200,
      url: `https://www.youtube.com/watch?v=tLTNkKP2oyw`,
      text: async () => liveHtml("tLTNkKP2oyw"),
    }));
    const res = await GET(req(false, freshChannel()));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.live).toBe(true);
    expect(json.videoId).toBe("tLTNkKP2oyw");
  });

  it("returns ok:true + live:false only on a successful parse with no live video", async () => {
    mockFetchOnce(async () => ({
      ok: true,
      status: 200,
      url: `https://www.youtube.com/channel/${CHANNEL}/live`,
      text: async () => offlineHtml(),
    }));
    const res = await GET(req(false, freshChannel()));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.live).toBe(false);
  });

  it("returns ok:false (never 'offline') when the fetch throws", async () => {
    mockFetchOnce(async () => {
      throw new Error("fetch failed");
    });
    const res = await GET(req(false, freshChannel()));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.live).toBe(false);
  });

  it("returns ok:false on a non-2xx from YouTube (rate-limit etc. is not 'offline')", async () => {
    mockFetchOnce(async () => ({
      ok: false,
      status: 429,
      url: `https://www.youtube.com/channel/${CHANNEL}/live`,
      text: async () => "rate limited",
    }));
    const res = await GET(req(false, freshChannel()));
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.live).toBe(false);
  });

  it("still 400s on a malformed channel id", async () => {
    const bad = new NextRequest("http://localhost/api/youtube-live?channel=nope", {
      method: "GET",
    });
    const res = await GET(bad);
    expect(res.status).toBe(400);
  });

  it("debug mode surfaces the failure metadata", async () => {
    mockFetchOnce(async () => {
      throw new Error("boom");
    });
    const res = await GET(req(true, freshChannel()));
    const json = (await res.json()) as {
      ok: boolean;
      debug: { error: string | null };
    };
    expect(json.ok).toBe(false);
    expect(json.debug.error).toMatch(/boom/);
  });
});
