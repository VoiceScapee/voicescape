/**
 * GET /api/social/activity tests: the X/Discord bot-post feed.
 *
 * Empty until automation resumes (200 with [] — never an error), then
 * newest-first events seeded through logSocialPost(). Rate limiting is
 * mocked open; the store is the in-memory fallback.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/rate-limit", () => ({
  ipGate: async () => null,
}));

import { resetKvStoreSingleton } from "@/lib/server/store";
import { logSocialPost } from "@/lib/server/social-activity";
import { GET } from "./route";

function req(): NextRequest {
  return new NextRequest("http://localhost/api/social/activity");
}

beforeEach(() => {
  resetKvStoreSingleton();
  vi.resetModules();
  // The merged reader also checks the gist sink — keep it empty/offline.
  globalThis.fetch = (async () => ({
    ok: true,
    text: async () => "[]",
  })) as unknown as typeof fetch;
});

describe("GET /api/social/activity", () => {
  it("returns 200 with an empty list when nothing was posted", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.events).toEqual([]);
  });

  it("returns newest-first events after posts are logged", async () => {
    await logSocialPost("x", "morning post");
    await logSocialPost("discord", "ship log");
    const res = await GET(req());
    const body = await res.json();
    expect(body.events).toHaveLength(2);
    expect(body.events[0].platform).toBe("discord");
    expect(body.events[1].platform).toBe("x");
  });

  it("merges gist-sink events into the content-free public feed", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      text: async () =>
        JSON.stringify([{ platform: "x", ts: "2026-09-27T20:00:00.000Z" }]),
    })) as unknown as typeof fetch;
    const res = await GET(req());
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    // Content-free contract: platform + ts only, no summary.
    expect(body.events[0]).toEqual({
      platform: "x",
      ts: "2026-09-27T20:00:00.000Z",
    });
  });

  it("sets a short public cache header for pollers", async () => {
    const res = await GET(req());
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=30");
  });
});
