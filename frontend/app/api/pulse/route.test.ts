/**
 * GET /api/pulse tests: cold start awaits the first fetch (no empty first
 * paint in serverless), warm requests serve cache, and a dead/malformed
 * feed fails open with 200 — headlines drop out but the curated video clips
 * (static, always available) still ship.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/rate-limit", () => ({
  checkIpRateLimit: async () => ({ allowed: true }),
  clientIpFromHeaders: () => "test-ip",
  ipRateLimitFromEnv: (_name: string, fallback: number) => fallback,
}));

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<item><title>How to unlock the full potential of HCS</title>
<link>https://hedera.com/blog/how-to-unlock-hcs</link>
<pubDate>Mon, 08 Sep 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

interface Item {
  title: string;
  url: string;
  date: string;
  source: string;
  kind: "article" | "video";
  thumb: string;
}

function req(): NextRequest {
  return new NextRequest("http://localhost/api/pulse");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/pulse", () => {
  it("cold start: awaits the feed and returns featured clips + headlines", async () => {
    const fetchMock = vi.fn(async () => new Response(RSS, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    const res = await GET(req());
    const json = (await res.json()) as { updatedAt: string | null; items: Item[] };
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 5 curated videos lead, the 1 RSS article follows.
    expect(json.items).toHaveLength(6);
    expect(json.items.slice(0, 5).every((i) => i.kind === "video")).toBe(true);
    expect(json.items[5].kind).toBe("article");
    expect(json.items[5].title).toContain("HCS");
    expect(json.items[0].thumb).toContain("i.ytimg.com");
    expect(json.updatedAt).not.toBeNull();
  });

  it("warm: serves cache without re-fetching within the TTL", async () => {
    const fetchMock = vi.fn(async () => new Response(RSS, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    await GET(req());
    const res = await GET(req());
    const json = (await res.json()) as { items: Item[] };
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(json.items).toHaveLength(6);
  });

  it("malformed feed: 200 with the curated clips, headlines drop out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("this is not xml", { status: 200 })));
    const { GET } = await import("./route");
    const res = await GET(req());
    const json = (await res.json()) as { items: Item[] };
    expect(res.status).toBe(200);
    expect(json.items).toHaveLength(5);
    expect(json.items.every((i) => i.kind === "video")).toBe(true);
  });

  it("dead feed: 200 with the curated clips, never a throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const { GET } = await import("./route");
    const res = await GET(req());
    const json = (await res.json()) as { items: Item[] };
    expect(res.status).toBe(200);
    expect(json.items).toHaveLength(5);
    expect(json.items.every((i) => i.kind === "video")).toBe(true);
  });
});
