/**
 * GET /api/pulse tests: cold start awaits the first fetch (no empty first
 * paint in serverless), warm requests serve cache, and a dead/malformed
 * feed fails open with 200 — headlines drop out but the curated video clips
 * (static, always available) still ship.
 *
 * Headline lanes: Hedera (official blog) + global crypto (CoinDesk,
 * Cointelegraph, Decrypt, The Block) with equal per-lane quotas, interleaved
 * so the on-screen mix stays 50/50.
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
  it("cold start: awaits the feeds and returns featured clips + balanced headlines", async () => {
    const fetchMock = vi.fn(async () => new Response(RSS, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    const res = await GET(req());
    const json = (await res.json()) as { updatedAt: string | null; items: Item[] };
    expect(res.status).toBe(200);
    // One fetch per feed: Hedera Blog + 4 global crypto outlets.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // 5 curated videos lead, then interleaved lane articles: the single
    // Hedera article first, then one per crypto outlet.
    expect(json.items).toHaveLength(10);
    expect(json.items.slice(0, 5).every((i) => i.kind === "video")).toBe(true);
    const articles = json.items.slice(5);
    expect(articles.every((i) => i.kind === "article")).toBe(true);
    expect(articles[0].source).toBe("Hedera Blog");
    expect(articles[0].title).toContain("HCS");
    expect(articles.slice(1).map((a) => a.source)).toEqual([
      "CoinDesk",
      "Cointelegraph",
      "Decrypt",
      "The Block",
    ]);
    expect(json.items[0].thumb).toContain("i.ytimg.com");
    expect(json.updatedAt).not.toBeNull();
  });

  it("lanes stay balanced: per-lane caps with newest-first interleaving", async () => {
    // Every feed returns 6 dated articles, newest first (RSS convention);
    // lanes cap at 4 each after a per-source fetch cap of 4.
    const rssFor = (source: string, n: number) => {
      const items = Array.from(
        { length: n },
        (_, k) => {
          const i = n - 1 - k; // newest first
          return (
            `<item><title>${source} story ${i}</title><link>https://${source}.example/${i}</link>` +
            `<pubDate>Mon, 08 Sep 2026 1${i}:00:00 GMT</pubDate></item>`
          );
        },
      ).join("");
      return `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
    };
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      const source = u.includes("hedera.com")
        ? "hedera"
        : u.includes("coindesk")
          ? "coindesk"
          : u.includes("cointelegraph")
            ? "cointelegraph"
            : u.includes("decrypt")
              ? "decrypt"
              : "theblock";
      return new Response(rssFor(source, 6), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    const res = await GET(req());
    const json = (await res.json()) as { items: Item[] };
    const articles = json.items.filter((i) => i.kind === "article");
    // 4 Hedera + 4 crypto, interleaved hedera/crypto.
    expect(articles).toHaveLength(8);
    expect(articles.filter((a) => a.source === "Hedera Blog")).toHaveLength(4);
    expect(articles.filter((a) => a.source !== "Hedera Blog")).toHaveLength(4);
    expect(articles.map((a) => (a.source === "Hedera Blog" ? "H" : "C")).join("")).toBe(
      "HCHCHCHC",
    );
    // Newest first within each lane.
    expect(articles[0].title).toBe("hedera story 5");
    expect(articles[1].title).toBe("coindesk story 5");
  });

  it("warm: serves cache without re-fetching within the TTL", async () => {
    const fetchMock = vi.fn(async () => new Response(RSS, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("./route");
    await GET(req());
    const res = await GET(req());
    const json = (await res.json()) as { items: Item[] };
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(json.items).toHaveLength(10);
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
