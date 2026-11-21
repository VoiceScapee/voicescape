/**
 * robots.txt: welcome crawlers on every public page, keep them out of
 * private/operational surfaces (/api/*, /mod, /analytics), and point them
 * at the sitemap. One exception: /api/mcp answers plain GETs with a
 * machine-readable "this is an MCP endpoint, here's how to connect"
 * pointer, so fetch tools are allowed there instead of hitting a
 * ROBOTS_DISALLOWED wall.
 *
 * AI discoverability (2026-11-20): the documented AI search crawlers are
 * named explicitly — a wildcard allow is not a discoverability signal,
 * and explicit groups let each platform be switched independently.
 * Crawler names verified against each platform's official docs 2026-11-20:
 * OpenAI developers.openai.com/api/docs/bots (OAI-SearchBot = search,
 * GPTBot = training, ChatGPT-User = user-triggered fetch); Anthropic
 * support.claude.com (Claude-SearchBot = search, ClaudeBot = training,
 * Claude-User = user-triggered fetch); Perplexity docs (PerplexityBot,
 * Perplexity-User); Apple/Google/Microsoft docs (Applebot, Googlebot,
 * Bingbot). Search and training are INDEPENDENT switches per platform.
 *
 * Training crawlers (GPTBot, ClaudeBot) are ALLOWED as of 2026-11-20 on
 * Brandon's word ("allow gptbot and claudebot"). Search and training
 * remain independent switches per platform; this opens the training
 * switch. GPTBot/ClaudeBot now fall under the wildcard allow below.
 *
 * NO Grok rule on purpose: xAI publishes no verified Grok search-crawler
 * name, UA, IP ranges, or robots.txt policy (checked 2026-11-20). The
 * community-reported names (GrokBot, xAI-SearchBot) are unverified and
 * must not be added as if official. Grok's web search fetches pages
 * without a declared identity, so the posture is: keep public pages
 * retrievable by ordinary web fetch.
 */
import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/seo";

/** Documented AI search crawlers + user-triggered fetchers (allow). */
export const AI_SEARCH_CRAWLERS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Googlebot",
  "Bingbot",
  "Applebot",
];

export default function robots(): MetadataRoute.Robots {
  const origin = siteUrl();
  return {
    rules: [
      {
        userAgent: AI_SEARCH_CRAWLERS,
        allow: ["/", "/api/mcp"],
        disallow: ["/api/", "/mod", "/analytics"],
      },
      {
        userAgent: "*",
        allow: ["/", "/api/mcp"],
        disallow: ["/api/", "/mod", "/analytics"],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}
