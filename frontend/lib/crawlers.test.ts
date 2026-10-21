/**
 * Crawler tracker matching tests — deterministic, no network.
 *
 * Covers every listed bot (canonical name), the longest-match rule
 * (Applebot-Extended beats Applebot), non-matches (browsers, curl,
 * empty/missing UA), machine-readable paths (exact + prefix boundary),
 * static-asset exclusion, the record/skip order, and key building.
 */
import { describe, expect, it } from "vitest";
import {
  BOT_PATTERNS,
  UNKNOWN_AGENT,
  botDayKey,
  botFirstKey,
  botLastKey,
  dayKey,
  isMachineReadablePath,
  isStaticAssetPath,
  matchBot,
  pathDayKey,
  sanitizePath,
  shouldRecord,
} from "./crawlers";

const BOT_UAS: Record<string, string> = {
  GPTBot: "Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  "ChatGPT-User": "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com)",
  "OAI-SearchBot": "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com)",
  ClaudeBot: "Mozilla/5.0 AppleWebKit/537.36 (compatible; ClaudeBot/1.0; +https://anthropic.com)",
  "Claude-Web": "Mozilla/5.0 (compatible; Claude-Web/1.0)",
  "anthropic-ai": "Mozilla/5.0 (compatible; anthropic-ai/1.0)",
  PerplexityBot: "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai)",
  "Perplexity-User": "Mozilla/5.0 (compatible; Perplexity-User/1.0)",
  "Google-Extended": "Mozilla/5.0 (compatible; Google-Extended/1.0)",
  Applebot: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 Applebot/0.1",
  "Applebot-Extended": "Mozilla/5.0 AppleWebKit/537.36 (compatible; Applebot-Extended/1.0)",
  CCBot: "CCBot/2.0 (https://commoncrawl.org/faq/)",
  "cohere-ai": "Mozilla/5.0 (compatible; cohere-ai/1.0)",
  "Meta-ExternalAgent": "Mozilla/5.0 (compatible; Meta-ExternalAgent/1.1; +https://developers.facebook.com)",
  "Meta-ExternalFetcher": "Mozilla/5.0 (compatible; Meta-ExternalFetcher/1.1)",
  FacebookBot: "facebookexternalhit/1.1; FacebookBot/1.0",
  Bytespider: "Mozilla/5.0 (compatible; Bytespider/1.0; +https://bytedance.com)",
  YouBot: "Mozilla/5.0 (compatible; YouBot/1.0; +https://you.com)",
  DuckAssistBot: "Mozilla/5.0 (compatible; DuckAssistBot/1.0; +https://duckduckgo.com)",
  Amazonbot: "Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com)",
};

describe("matchBot", () => {
  it("recognizes every listed bot by its canonical name", () => {
    for (const pattern of BOT_PATTERNS) {
      expect(matchBot(BOT_UAS[pattern])).toBe(pattern);
    }
  });

  it("prefers the longest match: Applebot-Extended beats Applebot", () => {
    expect(matchBot(BOT_UAS["Applebot-Extended"])).toBe("Applebot-Extended");
    expect(matchBot(BOT_UAS["Applebot"])).toBe("Applebot");
  });

  it("matches case-insensitively", () => {
    expect(matchBot("mozilla/5.0 (compatible; gptbot/1.0)")).toBe("GPTBot");
    expect(matchBot("Mozilla/5.0 (compatible; CLAUDEBOT/1.0)")).toBe("ClaudeBot");
  });

  it("returns null for ordinary browsers, curl, empty, and missing UAs", () => {
    expect(
      matchBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
    ).toBeNull();
    expect(matchBot("curl/8.5.0")).toBeNull();
    expect(matchBot("")).toBeNull();
    expect(matchBot(null)).toBeNull();
    expect(matchBot(undefined)).toBeNull();
  });
});

describe("isMachineReadablePath", () => {
  it("matches every exact machine-readable path", () => {
    for (const p of [
      "/.well-known/agent-card.json",
      "/agent.json",
      "/llms.txt",
      "/robots.txt",
      "/sitemap.xml",
    ]) {
      expect(isMachineReadablePath(p)).toBe(true);
    }
  });

  it("matches /api/agents and /api/mcp themselves and everything under them", () => {
    expect(isMachineReadablePath("/api/agents")).toBe(true);
    expect(isMachineReadablePath("/api/agents/directory")).toBe(true);
    expect(isMachineReadablePath("/api/mcp")).toBe(true);
    expect(isMachineReadablePath("/api/mcp/stats")).toBe(true);
  });

  it("respects the prefix boundary: /api/agentsfoo and /api/mcpfoo are not matches", () => {
    expect(isMachineReadablePath("/api/agentsfoo")).toBe(false);
    expect(isMachineReadablePath("/api/mcpfoo")).toBe(false);
    expect(isMachineReadablePath("/agents")).toBe(false);
    expect(isMachineReadablePath("/")).toBe(false);
  });
});

describe("isStaticAssetPath", () => {
  it("flags framework internals, favicon, and asset extensions", () => {
    expect(isStaticAssetPath("/_next/static/chunks/app.js")).toBe(true);
    expect(isStaticAssetPath("/_next/image?url=x")).toBe(true);
    expect(isStaticAssetPath("/favicon.ico")).toBe(true);
    expect(isStaticAssetPath("/logo.png")).toBe(true);
    expect(isStaticAssetPath("/font.woff2")).toBe(true);
  });

  it("never flags machine-readable files as assets", () => {
    expect(isStaticAssetPath("/llms.txt")).toBe(false);
    expect(isStaticAssetPath("/robots.txt")).toBe(false);
    expect(isStaticAssetPath("/sitemap.xml")).toBe(false);
  });

  it("does not flag pages or API routes", () => {
    expect(isStaticAssetPath("/")).toBe(false);
    expect(isStaticAssetPath("/agents")).toBe(false);
    expect(isStaticAssetPath("/api/agents")).toBe(false);
  });
});

describe("shouldRecord", () => {
  const gpt = BOT_UAS["GPTBot"];
  const browser =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

  it("records a bot on any non-asset page", () => {
    expect(shouldRecord(gpt, "/")).toEqual({ bot: "GPTBot", path: "/" });
    expect(shouldRecord(gpt, "/agents")).toEqual({ bot: "GPTBot", path: "/agents" });
  });

  it("records machine-readable paths for any UA as unknown-agent when unrecognized", () => {
    expect(shouldRecord(browser, "/llms.txt")).toEqual({
      bot: UNKNOWN_AGENT,
      path: "/llms.txt",
    });
    expect(shouldRecord(null, "/.well-known/agent-card.json")).toEqual({
      bot: UNKNOWN_AGENT,
      path: "/.well-known/agent-card.json",
    });
    expect(shouldRecord(gpt, "/llms.txt")).toEqual({ bot: "GPTBot", path: "/llms.txt" });
  });

  it("skips static assets even for bots", () => {
    expect(shouldRecord(gpt, "/logo.png")).toBeNull();
    expect(shouldRecord(gpt, "/_next/static/chunks/app.js")).toBeNull();
    expect(shouldRecord(gpt, "/favicon.ico")).toBeNull();
  });

  it("skips ordinary human traffic", () => {
    expect(shouldRecord(browser, "/")).toBeNull();
    expect(shouldRecord(browser, "/agents")).toBeNull();
    expect(shouldRecord(null, "/")).toBeNull();
    expect(shouldRecord("", "/api/mcp")).toEqual({
      bot: UNKNOWN_AGENT,
      path: "/api/mcp",
    });
  });

  it("never records the tracker's own stats endpoint", () => {
    expect(shouldRecord(gpt, "/api/crawlers/stats")).toBeNull();
    expect(shouldRecord(browser, "/api/crawlers/stats")).toBeNull();
  });
});

describe("key building", () => {
  it("formats UTC day keys", () => {
    expect(dayKey(new Date("2026-10-21T23:30:00Z"))).toBe("2026-10-21");
    expect(dayKey(new Date("2026-10-22T00:30:00Z"))).toBe("2026-10-22");
  });

  it("builds stable, distinct keys per bot, path, and day", () => {
    expect(botDayKey("2026-10-21", "GPTBot")).toBe("crawler:v1:day:2026-10-21:bot:GPTBot");
    expect(pathDayKey("2026-10-21", "/llms.txt")).toBe(
      "crawler:v1:day:2026-10-21:path:%2Fllms.txt",
    );
    expect(botDayKey("2026-10-21", "GPTBot")).not.toBe(
      botDayKey("2026-10-22", "GPTBot"),
    );
    expect(botFirstKey("GPTBot")).toBe("crawler:v1:bot:GPTBot:first");
    expect(botLastKey("GPTBot")).toBe("crawler:v1:bot:GPTBot:last");
  });

  it("sanitizes paths: caps length and strips control chars", () => {
    expect(sanitizePath("/ok/path")).toBe("/ok/path");
    expect(sanitizePath("/a\nb\tc")).toBe("/a_b_c");
    expect(sanitizePath("/" + "x".repeat(500))).toHaveLength(200);
  });
});
