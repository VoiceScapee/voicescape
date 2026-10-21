import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/agents-directory", () => ({
  scanRegisteredUsernames: vi.fn(),
}));

vi.mock("@/lib/contracts", () => ({
  getRegistryAddress: vi.fn(),
}));

import sitemap, {
  SITEMAP_STATIC_ROUTES,
  SITEMAP_MAX_USERNAMES,
  sitemapUsernames,
  sitemapReservedFirstSegments,
} from "./sitemap";
import robots from "./robots";
import { scanRegisteredUsernames } from "@/lib/server/agents-directory";
import { getRegistryAddress } from "@/lib/contracts";

const VALID_FREQ = new Set([
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
]);

describe("sitemap static routes", () => {
  it("lists the public surfaces with valid priority and frequency", () => {
    const paths = SITEMAP_STATIC_ROUTES.map((r) => r.path);
    for (const p of [
      "/",
      "/forum",
      "/chat",
      "/marketplace",
      "/leaderboard",
      "/builder",
      "/agents",
      "/intros",
      "/ai-agent",
      "/explore",
      "/console",
    ]) {
      expect(paths).toContain(p);
    }
    // Private/operational surfaces must NOT be indexed.
    for (const p of ["/mod", "/analytics", "/api/townhall/chat"]) {
      expect(paths).not.toContain(p);
    }
    // No duplicate entries: a duplicated path would double-list a URL.
    expect(new Set(paths).size).toBe(paths.length);
    for (const r of SITEMAP_STATIC_ROUTES) {
      expect(r.priority).toBeGreaterThan(0);
      expect(r.priority).toBeLessThanOrEqual(1);
      expect(VALID_FREQ.has(r.changeFrequency as string)).toBe(true);
    }
  });

  it("caps the username count", () => {
    expect(SITEMAP_MAX_USERNAMES).toBeLessThanOrEqual(100);
  });
});

describe("sitemap()", () => {
  beforeEach(() => {
    vi.mocked(scanRegisteredUsernames).mockReset();
    vi.mocked(getRegistryAddress).mockReset();
    vi.mocked(getRegistryAddress).mockReturnValue("0.0.10854058");
  });

  it("serves static routes with absolute URLs when the registry scan fails", async () => {
    vi.mocked(scanRegisteredUsernames).mockRejectedValue(
      new Error("mirror down"),
    );
    const entries = await sitemap();
    expect(entries.length).toBe(SITEMAP_STATIC_ROUTES.length);
    for (const e of entries) {
      expect(e.url).toMatch(/^https?:\/\//);
    }
    expect(entries[0].url).toMatch(/\/$/);
  });

  it("serves static routes only when the registry is unconfigured", async () => {
    vi.mocked(getRegistryAddress).mockReturnValue(undefined);
    const entries = await sitemap();
    expect(entries.length).toBe(SITEMAP_STATIC_ROUTES.length);
    expect(scanRegisteredUsernames).not.toHaveBeenCalled();
  });

  it("adds registered blockpages from the Registry scan, capped", async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      username: `user${String(i).padStart(3, "0")}`,
      registeredAt: null,
    }));
    vi.mocked(scanRegisteredUsernames).mockResolvedValue(rows);
    const entries = await sitemap();
    const profile = entries.filter((e) =>
      /^https?:\/\/[^/]+\/user\d{3}$/.test(e.url),
    );
    expect(profile.length).toBe(SITEMAP_MAX_USERNAMES);
  });

  it("skips registered names that collide with static routes and dedupes", async () => {
    vi.mocked(scanRegisteredUsernames).mockResolvedValue([
      { username: "agents", registeredAt: null },
      { username: "forum", registeredAt: null },
      { username: "api", registeredAt: null },
      { username: "alice", registeredAt: null },
      { username: "alice", registeredAt: null },
      { username: "bob", registeredAt: null },
    ]);
    const names = await sitemapUsernames();
    expect(names).toEqual(["alice", "bob"]);
  });

  it("sitemapUsernames never throws", async () => {
    vi.mocked(scanRegisteredUsernames).mockRejectedValue(new Error("boom"));
    await expect(sitemapUsernames()).resolves.toEqual([]);
  });

  it("reserved segments cover every static route's first segment", () => {
    const reserved = sitemapReservedFirstSegments();
    for (const r of SITEMAP_STATIC_ROUTES) {
      const first = r.path.split("/")[1];
      if (first) expect(reserved.has(first)).toBe(true);
    }
    expect(reserved.has("api")).toBe(true);
  });
});

describe("robots()", () => {
  it("allows public pages, blocks private ones, references the sitemap", () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    const rule = rules[0];
    expect(rule.userAgent).toBe("*");
    // /api/mcp is deliberately allowed: it answers plain GETs with a
    // machine-readable "this is an MCP endpoint" pointer instead of a
    // ROBOTS_DISALLOWED wall for fetch tools.
    expect(rule.allow).toEqual(["/", "/api/mcp"]);
    const disallow = rule.disallow as string[];
    expect(disallow).toContain("/api/");
    expect(disallow).toContain("/mod");
    expect(disallow).toContain("/analytics");
    expect(r.sitemap).toMatch(/^https?:\/\/.*\/sitemap\.xml$/);
  });
});
