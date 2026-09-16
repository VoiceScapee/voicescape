/**
 * GET /api/landing/featured — curated featured-blockpages list with live stats.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/contracts", () => ({
  resolvePage: vi.fn(),
}));
vi.mock("@/lib/ipfs", () => ({
  fetchPageJson: vi.fn(),
}));
vi.mock("@/lib/server/store", () => ({
  getKvStore: vi.fn(() => ({})),
}));
vi.mock("@/lib/follows", () => ({
  followerCount: vi.fn(),
}));
vi.mock("@/lib/server/townhall/badges", () => ({
  computeBadges: vi.fn(),
  defaultDepsForBadges: vi.fn(() => ({ hcs: {} })),
}));

import { resolvePage } from "@/lib/contracts";
import { fetchPageJson } from "@/lib/ipfs";
import { followerCount } from "@/lib/follows";
import { computeBadges } from "@/lib/server/townhall/badges";
import { GET } from "./route";

const resolvePageMock = vi.mocked(resolvePage);
const fetchPageJsonMock = vi.mocked(fetchPageJson);
const followerCountMock = vi.mocked(followerCount);
const computeBadgesMock = vi.mocked(computeBadges);

function featuredReq(): NextRequest {
  return new NextRequest("http://localhost/api/landing/featured", { method: "GET" });
}

const pageJson = (title: string, avatarEmoji?: string, livestream?: object) =>
  JSON.stringify({
    blocks: [
      { type: "hero", title, ...(avatarEmoji ? { avatarEmoji } : {}) },
      ...(livestream ? [livestream] : []),
    ],
  });

beforeEach(() => {
  vi.clearAllMocks();
  resolvePageMock.mockImplementation(async (username: string) => ({
    owner: "0x0000000000000000000000000000000000000001",
    ipfsHash: `Qm${username}`,
    ownerType: username === "forge" ? 1 : 0,
    operator: "0x0000000000000000000000000000000000000000",
    purpose: "",
  }));
  fetchPageJsonMock.mockImplementation(async (hash: string) =>
    pageJson(`Title for ${hash}`, "🦕"),
  );
  followerCountMock.mockResolvedValue(7);
  computeBadgesMock.mockResolvedValue({
    username: "x",
    badges: [{ id: "publisher", name: "Publisher", description: "", icon: "🏅", category: "x" }],
    stats: {},
  } as never);
  // youtube-live self-fetch: offline by default
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ live: false }) })),
  );
});

describe("GET /api/landing/featured", () => {
  it("returns the four curated pages with live stats", async () => {
    const res = await GET(featuredReq());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pages: { username: string }[] };
    expect(json.pages.map((p) => p.username).sort()).toEqual(
      ["ash-rook", "bacon-the-dino", "forge", "user-10424063"].sort(),
    );
  });

  it("extracts the hero title and avatar emoji from the page JSON", async () => {
    const res = await GET(featuredReq());
    const json = (await res.json()) as {
      pages: { username: string; displayName: string; avatarEmoji: string | null }[];
    };
    const bacon = json.pages.find((p) => p.username === "bacon-the-dino")!;
    expect(bacon.displayName).toBe("Title for Qmbacon-the-dino");
    expect(bacon.avatarEmoji).toBe("🦕");
  });

  it("marks agent pages from the on-chain ownerType", async () => {
    const res = await GET(featuredReq());
    const json = (await res.json()) as { pages: { username: string; ownerType: number }[] };
    expect(json.pages.find((p) => p.username === "forge")!.ownerType).toBe(1);
    expect(json.pages.find((p) => p.username === "user-10424063")!.ownerType).toBe(0);
  });

  it("sorts by badge count, then followers — most first", async () => {
    followerCountMock.mockImplementation(async (_store: unknown, username: string) =>
      username === "ash-rook" ? 99 : 1,
    );
    computeBadgesMock.mockImplementation(async (_hcs: unknown, input: { username: string }) => ({
      username: input.username,
      badges:
        input.username === "forge"
          ? [
              { id: "a", name: "A", description: "", icon: "🏅", category: "x" },
              { id: "b", name: "B", description: "", icon: "🎖️", category: "x" },
            ]
          : [],
      stats: {},
    }) as never);
    const res = await GET(featuredReq());
    const json = (await res.json()) as { pages: { username: string }[] };
    const order = json.pages.map((p) => p.username);
    // forge has the most badges → first; ash-rook has the most followers → second
    expect(order[0]).toBe("forge");
    expect(order[1]).toBe("ash-rook");
  });

  it("degrades gracefully when a page fails to resolve", async () => {
    resolvePageMock.mockImplementation(async (username: string) =>
      username === "ash-rook" ? null : {
        owner: "0x0000000000000000000000000000000000000001",
        ipfsHash: "Qmx",
        ownerType: 0,
        operator: "0x0000000000000000000000000000000000000000",
        purpose: "",
      },
    );
    const res = await GET(featuredReq());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pages: { username: string; displayName: string }[] };
    expect(json.pages).toHaveLength(4);
    expect(json.pages.find((p) => p.username === "ash-rook")!.displayName).toBe("@ash-rook");
  });

  it("reports live:true when the page's YouTube stream is playing", async () => {
    fetchPageJsonMock.mockImplementation(async (hash: string) =>
      pageJson(`Title for ${hash}`, undefined, {
        type: "livestream",
        platform: "youtube",
        channel: "UCuAXFkgsw1Lo0R2-JhgrUhw",
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ live: true, videoId: "abc" }) })),
    );
    const res = await GET(featuredReq());
    const json = (await res.json()) as { pages: { username: string; live: boolean }[] };
    expect(json.pages.every((p) => p.live)).toBe(true);
  });
});
