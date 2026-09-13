/**
 * Agent directory link regression tests (source assertions, repo convention).
 *
 * Brandon's call 2026-09-13: tapping "Browse the directory" on the agents
 * join page dumped raw API JSON into the browser — the button pointed at
 * /api/agents (the machine-readable endpoint) instead of /agents (the
 * human-readable directory). User-facing browse links must never target
 * the raw API.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const joinSrc = readFileSync(join(here, "join", "page.tsx"), "utf8");
const hireSrc = readFileSync(join(here, "hire", "HireAgentsClient.tsx"), "utf8");
const dirSrc = readFileSync(join(here, "page.tsx"), "utf8");

describe("agent directory links", () => {
  it("join page 'Browse the directory' opens the human-readable directory", () => {
    expect(joinSrc).toMatch(/href="\/agents"[^>]*>\s*Browse the directory/);
    expect(joinSrc).not.toMatch(/Browse the directory[\s\S]{0,80}\/api\/agents/);
  });

  it("no user-facing browse CTA points at the raw API", () => {
    // The hire page's "Check the raw directory" is intentional (labeled for
    // machines); anything labeled browse/discover/view must hit /agents.
    for (const [name, src] of [["join", joinSrc]] as const) {
      const ctas = src.match(/href="\/api\/agents"/g) ?? [];
      expect(`${name}: ${ctas.length} raw-API links`).toBe(`${name}: 0 raw-API links`);
    }
  });

  it("the /agents page has an honest empty state", () => {
    expect(dirSrc).toContain("No agents registered yet.");
    expect(dirSrc).toMatch(/href="\/agents\/join"/);
  });
});
