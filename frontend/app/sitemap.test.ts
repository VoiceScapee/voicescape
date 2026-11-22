import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/server/agents-directory", () => ({
  scanRegisteredUsernames: vi.fn(),
}));

vi.mock("@/lib/contracts", () => ({
  getRegistryAddress: vi.fn(),
}));

import sitemap, {
  SITEMAP_EXCLUDED_USERNAMES,
  SITEMAP_STATIC_ROUTES,
  SITEMAP_MAX_USERNAMES,
  mirrorTimestampToIso,
  sitemapUsernameRows,
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
      "/embed",
      "/trust",
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

  it("excludes test/debug usernames from the sitemap", async () => {
    vi.mocked(scanRegisteredUsernames).mockResolvedValue([
      { username: "danny-debug-1", registeredAt: "2026-11-01T00:00:00Z" },
      { username: "human-test-0913", registeredAt: "2026-11-01T00:00:00Z" },
      { username: "alice", registeredAt: null },
    ]);
    const names = await sitemapUsernames();
    expect(names).toEqual(["alice"]);
    expect(SITEMAP_EXCLUDED_USERNAMES.has("danny-debug-1")).toBe(true);
    expect(SITEMAP_EXCLUDED_USERNAMES.has("human-test-0913")).toBe(true);
  });

  it("uses the real registration timestamp as each blockpage's lastmod", async () => {
    // Mirror-node timestamps are epoch seconds with a nanosecond fraction
    // ("1789350068.813732104" = danny's real registerPage call) — lastmod
    // must be ISO-8601, never the raw epoch string.
    vi.mocked(scanRegisteredUsernames).mockResolvedValue([
      { username: "alice", registeredAt: "1789350068.813732104" },
      { username: "bob", registeredAt: null },
    ]);
    const entries = await sitemap();
    const alice = entries.find((e) => e.url.endsWith("/alice"));
    const bob = entries.find((e) => e.url.endsWith("/bob"));
    expect(alice?.lastModified).toBe("2026-09-14T01:41:08.813Z");
    expect(alice?.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // No timestamp on file → no lastmod, never a made-up one.
    expect(bob?.lastModified).toBeUndefined();
    // Static routes carry no shared build timestamp either.
    const home = entries.find((e) => e.url.endsWith("/"));
    expect(home?.lastModified).toBeUndefined();
    // ...and no two entries share one identical lastmod anymore.
    const mods = entries
      .map((e) => e.lastModified)
      .filter((m): m is string => typeof m === "string");
    expect(new Set(mods).size).toBe(mods.length);
  });

  it("sitemapUsernameRows keeps the registration timestamp (as ISO)", async () => {
    vi.mocked(scanRegisteredUsernames).mockResolvedValue([
      { username: "alice", registeredAt: "1789350068.813732104" },
    ]);
    const rows = await sitemapUsernameRows();
    expect(rows).toEqual([
      { username: "alice", registeredAt: "2026-09-14T01:41:08.813Z" },
    ]);
  });

  it("mirrorTimestampToIso converts epoch seconds and rejects garbage", async () => {
    expect(mirrorTimestampToIso("1789350068.813732104")).toBe(
      "2026-09-14T01:41:08.813Z",
    );
    expect(mirrorTimestampToIso(null)).toBeNull();
    expect(mirrorTimestampToIso("not-a-timestamp")).toBeNull();
    expect(mirrorTimestampToIso("0")).toBeNull();
    // An already-ISO timestamp passes through normalized, never raw.
    expect(mirrorTimestampToIso("2026-10-05T12:34:56Z")).toBe(
      "2026-10-05T12:34:56.000Z",
    );
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
    // Rule order: AI search crawlers, then *.
    const search = rules.find((rule) =>
      (Array.isArray(rule.userAgent) ? rule.userAgent : [rule.userAgent]).includes(
        "OAI-SearchBot",
      ),
    );
    expect(search).toBeDefined();
    // /api/mcp is deliberately allowed: it answers plain GETs with a
    // machine-readable "this is an MCP endpoint" pointer instead of a
    // ROBOTS_DISALLOWED wall for fetch tools.
    expect(search!.allow).toEqual(["/", "/api/mcp"]);
    const searchDisallow = search!.disallow as string[];
    expect(searchDisallow).toContain("/api/");
    expect(searchDisallow).toContain("/mod");
    expect(searchDisallow).toContain("/analytics");
    const wildcard = rules.find((rule) => rule.userAgent === "*");
    expect(wildcard).toBeDefined();
    expect(wildcard!.allow).toEqual(["/", "/api/mcp"]);
    const wildDisallow = wildcard!.disallow as string[];
    expect(wildDisallow).toContain("/api/");
    expect(wildDisallow).toContain("/mod");
    expect(wildDisallow).toContain("/analytics");
    expect(r.sitemap).toMatch(/^https?:\/\/.*\/sitemap\.xml$/);
  });

  it("names the documented AI search crawlers and allows training crawlers", () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    const agents = (rule: (typeof rules)[number]): string[] => {
      const ua = rule.userAgent;
      if (Array.isArray(ua)) return ua;
      return ua ? [ua] : [];
    };
    const search = rules.find((rule) =>
      agents(rule).includes("Claude-SearchBot"),
    );
    expect(search).toBeDefined();
    for (const name of [
      "OAI-SearchBot",
      "ChatGPT-User",
      "Claude-SearchBot",
      "Claude-User",
      "PerplexityBot",
      "Perplexity-User",
      "Googlebot",
      "Bingbot",
      "Applebot",
    ]) {
      expect(agents(search!)).toContain(name);
    }
    // Training crawlers (GPTBot, ClaudeBot) are ALLOWED as of 2026-11-20
    // on Brandon's word: no rule names them, so they fall under the
    // wildcard allow. Search and training remain independent switches.
    const training = rules.find(
      (rule) => agents(rule).includes("GPTBot") || agents(rule).includes("ClaudeBot"),
    );
    expect(training).toBeUndefined();
    const wildcard = rules.find((rule) => rule.userAgent === "*");
    expect(wildcard).toBeDefined();
    expect(wildcard!.allow).toEqual(["/", "/api/mcp"]);
    // No Grok rule: xAI publishes no verified search-crawler name.
    for (const rule of rules) {
      for (const a of agents(rule)) {
        expect(a.toLowerCase()).not.toContain("grok");
      }
    }
  });
});
