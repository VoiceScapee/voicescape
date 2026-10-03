import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * /mcp is the call-to-action page for the MCP server. /api/mcp is a
 * machine endpoint — a browser opening it must land here (302) instead of
 * staring at a JSON-RPC "Method not allowed" error. The page must convert:
 * copy-paste connect snippets, the exact first three calls, and an honest
 * tool list matching the registrations in lib/server/mcp-tool-registry.ts.
 */
describe("MCP call-to-action page (/mcp)", () => {
  const pageSrc = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  const routeSrc = readFileSync(
    new URL("../../lib/server/mcp-tool-registry.ts", import.meta.url),
    "utf8",
  );
  const routeHandlerSrc = readFileSync(
    new URL("../api/mcp/route.ts", import.meta.url),
    "utf8",
  );

  it("leads with a call to action, not a definition", () => {
    expect(pageSrc).toContain("Plug your agent into Voicescape");
  });

  it("gives copy-paste connect snippets for Claude Code and generic clients", () => {
    expect(pageSrc).toContain("claude mcp add --transport http voicescape");
    expect(pageSrc).toContain("https://voicescape.vercel.app/api/mcp");
    expect(pageSrc).toContain('"mcpServers"');
    expect(pageSrc).toContain("CopyButton");
  });

  it("spells out the first three calls an agent should make", () => {
    for (const tool of ["search_agents", "verify_tip", "post_agent_intro"]) {
      expect(pageSrc).toContain(tool);
    }
    expect(pageSrc).toMatch(/first three calls/i);
  });

  it("lists every public tool registered in the route, no more", () => {
    for (const tool of [
      "lookup_blockpage",
      "verify_tip",
      "treasury_stats",
      "recent_tips",
      "search_agents",
      "check_profile_pin",
      "post_agent_intro",
      "post_agent_feedback",
      "check_feedback_status",
      "list_open_bugs",
      "render_blockpage",
      "render_blockpage_image",
    ]) {
      expect(routeSrc).toContain(`"${tool}"`);
      expect(pageSrc).toContain(tool);
    }
  });

  it("has no operator tier anymore: public tools only", () => {
    expect(pageSrc).not.toMatch(/prepare_tip/);
    expect(pageSrc).not.toMatch(/prepare_contract_call/);
    expect(pageSrc).not.toMatch(/operator/i);
    expect(pageSrc).toMatch(/eighteen public tools/i);
  });

  it("states the rate limit and the Hedera mainnet source honestly", () => {
    expect(pageSrc).toContain("20 requests per hour");
    expect(pageSrc).toMatch(/Hedera mainnet/);
    expect(pageSrc).toMatch(/unverified/);
  });

  it("redirects browser GETs on /api/mcp to /mcp before the rate limiter", () => {
    const redirectIdx = routeHandlerSrc.indexOf('Response.redirect(new URL("/mcp"');
    expect(redirectIdx).toBeGreaterThan(-1);
    expect(routeHandlerSrc).toContain('includes("text/html")');
    // The redirect branch must come before the per-IP gate so human
    // clicks don't burn the MCP budget.
    const gateIdx = routeHandlerSrc.indexOf("checkIpRateLimit(");
    expect(redirectIdx).toBeLessThan(gateIdx);
  });

  it("is listed in the sitemap so agents can discover it", () => {
    const sitemapSrc = readFileSync(
      new URL("../sitemap.ts", import.meta.url),
      "utf8",
    );
    expect(sitemapSrc).toContain('"/mcp"');
  });
});
