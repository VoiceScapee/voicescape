import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * AgentLandingNav is the wayfinding bar on the agent landing pages
 * (/agents/start, /intros, /mcp). Those pages skip the full Navbar, so
 * without this bar an agent landing from a shared link is stranded with
 * no way back to the dapp. Every link must point at a real route.
 */
describe("AgentLandingNav", () => {
  const src = readFileSync(
    new URL("./AgentLandingNav.tsx", import.meta.url),
    "utf8",
  );

  it("links Home plus the key dapp surfaces", () => {
    for (const href of [
      "/",
      "/explore",
      "/forum",
      "/marketplace",
      "/agents",
      "/agents/start",
      "/intros",
      "/mcp",
    ]) {
      expect(src).toContain(`href: "${href}"`);
    }
  });

  it("every linked href resolves to a real route in the app dir", () => {
    const hrefs = [...src.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    const appDir = new URL("../app/", import.meta.url);
    for (const href of hrefs) {
      // Route groups like app/(townhall)/forum still serve /forum.
      const pageTsx =
        href === "/"
          ? new URL("page.tsx", appDir)
          : new URL(`${href.slice(1)}/page.tsx`, appDir);
      let ok = existsSync(pageTsx);
      if (!ok) {
        // Fall back: search for the segment under any route group.
        const seg = href.split("/").pop()!;
        ok = existsSync(new URL(`(townhall)/${seg}/page.tsx`, appDir));
      }
      expect(ok, `route ${href} has no page.tsx`).toBe(true);
    }
  });

  it("marks the current page so it reads as navigation", () => {
    expect(src).toContain("aria-current");
  });

  it("wraps instead of horizontal-scrolling so every link stays visible", () => {
    // The strip is capped at the 720px page container but the nine pills
    // need ~920px on one line; a scrollable strip with a hidden scrollbar
    // left "Agent intros" and "MCP server" unreachable at desktop width.
    expect(src).toContain('flexWrap: "wrap"');
    expect(src).not.toContain('overflowX: "auto"');
    expect(src).not.toContain('whiteSpace: "nowrap"');
  });

  it("is rendered by all three agent landing pages", () => {
    for (const [page, current] of [
      ["../app/agents/start/page.tsx", "/agents/start"],
      ["../app/intros/page.tsx", "/intros"],
      ["../app/mcp/page.tsx", "/mcp"],
    ]) {
      const pageSrc = readFileSync(new URL(page, import.meta.url), "utf8");
      expect(pageSrc).toContain("AgentLandingNav");
      expect(pageSrc).toContain(`current="${current}"`);
    }
  });
});
