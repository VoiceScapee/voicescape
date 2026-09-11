import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/townhall/badges", () => ({
  getTownhallStats: vi.fn(),
  scoreFromEntry: (u: { username: string }) => u.username.length,
}));

import sitemap, {
  SITEMAP_STATIC_ROUTES,
  SITEMAP_MAX_USERNAMES,
  sitemapUsernames,
} from "./sitemap";
import robots from "./robots";
import { getTownhallStats } from "@/lib/server/townhall/badges";

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
    for (const p of ["/", "/forum", "/chat", "/marketplace", "/leaderboard", "/builder"]) {
      expect(paths).toContain(p);
    }
    // Private/operational surfaces must NOT be indexed.
    for (const p of ["/mod", "/analytics", "/api/townhall/chat"]) {
      expect(paths).not.toContain(p);
    }
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
    vi.mocked(getTownhallStats).mockReset();
  });

  it("serves static routes with absolute URLs when HCS is down", async () => {
    vi.mocked(getTownhallStats).mockRejectedValue(new Error("mirror down"));
    const entries = await sitemap();
    expect(entries.length).toBe(SITEMAP_STATIC_ROUTES.length);
    for (const e of entries) {
      expect(e.url).toMatch(/^https?:\/\//);
    }
    expect(entries[0].url).toMatch(/\/$/);
  });

  it("adds top-100 profile URLs when HCS is up", async () => {
    const users: Record<string, { username: string }> = {};
    for (let i = 0; i < 150; i++) {
      const name = `user${String(i).padStart(3, "0")}`;
      users[name] = { username: name };
    }
    vi.mocked(getTownhallStats).mockResolvedValue({ users, scannedAt: 0 } as never);
    const entries = await sitemap();
    const profile = entries.filter((e) => /^https?:\/\/[^/]+\/user\d{3}$/.test(e.url));
    expect(profile.length).toBe(SITEMAP_MAX_USERNAMES);
  });

  it("sitemapUsernames never throws", async () => {
    vi.mocked(getTownhallStats).mockRejectedValue(new Error("boom"));
    await expect(sitemapUsernames()).resolves.toEqual([]);
  });
});

describe("robots()", () => {
  it("allows public pages, blocks private ones, references the sitemap", () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    const rule = rules[0];
    expect(rule.userAgent).toBe("*");
    expect(rule.allow).toBe("/");
    const disallow = rule.disallow as string[];
    expect(disallow).toContain("/api/");
    expect(disallow).toContain("/mod");
    expect(disallow).toContain("/analytics");
    expect(r.sitemap).toMatch(/^https?:\/\/.*\/sitemap\.xml$/);
  });
});
