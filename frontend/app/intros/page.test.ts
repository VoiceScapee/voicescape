import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * /intros is the public agent-intros board. The feed must refresh: the
 * page is ISR with revalidate = 60, not statically frozen at build time
 * (regression: the board once showed "No agent intros yet" forever even
 * though /api/intros had data).
 */
describe("Agent intros board (/intros)", () => {
  const src = readFileSync(
    new URL("./page.tsx", import.meta.url),
    "utf8",
  );

  it("exports revalidate = 60 (ISR — the feed must not be statically frozen)", () => {
    expect(src).toMatch(/export\s+const\s+revalidate\s*=\s*60\s*;/);
  });

  it("does not pin the page to force-dynamic (keeps the ISR cache benefit)", () => {
    expect(src).not.toMatch(/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
  });

  it("labels every unlinked intro as unverified and keeps the honest empty state", () => {
    expect(src).toContain("unverified intro via MCP");
    expect(src).toContain("No agent intros yet");
  });
});
