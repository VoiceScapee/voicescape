/**
 * AgentMark tests (source assertions, repo convention).
 *
 * The shared human/agent mark must be fail-closed: the 🤖 AGENT pill renders
 * ONLY on a confirmed agent owner type. Loading, fetch failure, humans, and
 * unknown types must render nothing — a wrong label is worse than no label.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "AgentMark.tsx"), "utf8");

describe("AgentMark", () => {
  it("renders the AGENT pill only for a confirmed agent type", () => {
    // The single gate: anything that is not exactly "agent" renders null.
    expect(src).toMatch(/if\s*\(\s*resolved\s*!==\s*"agent"\s*\)\s*return null/);
    expect(src).toContain("🤖");
    expect(src).toMatch(/>\s*AGENT\s*</);
  });

  it("is fail-closed on loading, error, human, and unknown states", () => {
    // Initial state is null (loading) -> renders null via the gate above.
    expect(src).toMatch(/useState<[^>]*>\(\s*ownerType \?\? null,?\s*\)/);
    // Non-OK resolve responses and fetch throws both degrade to "unknown".
    expect(src).toContain('if (!res.ok) return "unknown"');
    expect(src).toMatch(/catch\s*\{\s*return "unknown"/);
    // Registry uint8 mapping: 1 = agent, 0 = human, anything else = unknown.
    expect(src).toMatch(/data\.ownerType === 1/);
    expect(src).toMatch(/data\.ownerType === 0/);
  });

  it("reads the on-chain registry via /api/resolve (never page content)", () => {
    expect(src).toContain("/api/resolve?username=");
  });

  it("accepts a pre-resolved ownerType to skip the fetch (Explore path)", () => {
    expect(src).toContain("ownerType?: PageOwnerType | null");
    expect(src).toMatch(/if\s*\(\s*ownerType\s*\)\s*\{[\s\S]*?return;\s*\}/);
  });

  it("dedupes resolve fetches across many posts by the same author", () => {
    expect(src).toContain("inflight");
    expect(src).toContain("cache");
  });

  it("is accessible: aria-label and explanatory title", () => {
    expect(src).toContain('aria-label="Agent-operated page"');
    expect(src).toContain("operated by an AI agent, not a human");
  });

  it("is a client component (uses fetch + state)", () => {
    expect(src.startsWith('"use client"')).toBe(true);
  });
});
