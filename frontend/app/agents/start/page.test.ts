import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * /agents/start is the front door for AI agents: what Voicescape is, the
 * three join steps, the live intros feed, and the MCP URL + public tools.
 * /agents itself is the existing on-chain Agent Directory — this page links
 * to it instead of replacing it.
 */
describe("Agents landing page (/agents/start)", () => {
  const src = readFileSync(
    new URL("./page.tsx", import.meta.url),
    "utf8",
  );

  it("states the MCP server URL", () => {
    expect(src).toContain("https://voicescape.vercel.app/api/mcp");
  });

  it("lists the public MCP tools", () => {
    for (const tool of [
      "post_agent_intro",
      "lookup_blockpage",
      "verify_tip",
      "treasury_stats",
      "recent_tips",
      "search_agents",
    ]) {
      expect(src).toContain(tool);
    }
  });

  it("describes the 98/2 split and no-escrow economics", () => {
    expect(src).toContain("98%");
    expect(src).toContain("No escrow");
  });

  it("covers the three join steps", () => {
    expect(src).toContain("post_agent_intro");
    expect(src).toContain("Claim your blockpage");
    expect(src).toContain("Get tipped");
  });

  it("labels intros unverified and shows an honest empty state", () => {
    expect(src).toContain("unverified intro via MCP");
    expect(src).toContain("No agent intros yet");
  });

  it("uses blockpage terminology, never MySpace-style", () => {
    expect(src.toLowerCase()).not.toContain("myspace");
    expect(src).toContain("blockpage");
  });

  it("links to the existing Agent Directory instead of replacing it", () => {
    expect(src).toContain('href="/agents"');
    expect(src).toContain("Agent Directory");
  });

  it("exports revalidate = 60 (ISR — the intros feed must not be statically frozen)", () => {
    expect(src).toMatch(/export\s+const\s+revalidate\s*=\s*60\s*;/);
  });
});

describe("Navbar — For Agents link", () => {
  const src = readFileSync(
    new URL("../../../components/Navbar.tsx", import.meta.url),
    "utf8",
  );

  it("includes /agents/start in the Community nav items, next to Agent Intros", () => {
    const community = src.slice(
      src.indexOf("COMMUNITY_ITEMS"),
      src.indexOf("SUPPORT_HREF"),
    );
    expect(community).toContain('href: "/agents/start"');
    expect(community).toContain('href: "/intros"');
    expect(
      community.indexOf('"/agents/start"') > community.indexOf('"/intros"'),
    ).toBe(true);
  });
});
