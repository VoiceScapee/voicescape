import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Doc-vs-registry check: human-readable docs must not state a stale MCP
 * tool count. Catches the "README says 25 tools but we ship 30" drift.
 *
 * Rules:
 * - Exact claims like "30 tools" must match the registry count exactly.
 * - Lower-bound claims like "25+ tools" must not exceed the registry count
 *   (claiming "35+ tools" when we have 30 fails).
 * - Scans: repo README.md, frontend README (if present).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// lib/server/__tests__ -> repo root is ../../../..
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

async function registryToolCount(): Promise<number> {
  const { registerTools } = await import("../mcp-tool-registry");
  const names: string[] = [];
  const stub = {
    registerTool: (name: string) => {
      names.push(name);
    },
    registerResource: () => {},
  };
  registerTools(stub as any);
  return new Set(names).size;
}

function findDocFiles(): string[] {
  const candidates = [
    join(REPO_ROOT, "README.md"),
    join(REPO_ROOT, "frontend", "README.md"),
  ];
  return candidates.filter((p) => existsSync(p));
}

describe("docs match the live MCP tool count", () => {
  it("exact tool-count claims in docs match the registry", async () => {
    const count = await registryToolCount();
    expect(count).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const file of findDocFiles()) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        // Exact: "30 tools" (not "30+ tools")
        const exact = line.match(/(\d+)\s+tools?\b(?!\s*\+)/g);
        if (exact) {
          for (const m of exact) {
            const n = parseInt(m, 10);
            // Skip small numbers that aren't tool counts (e.g. "2 tools" in prose)
            if (n >= 10 && n !== count) {
              failures.push(
                `${file}:${i + 1}: claims "${m.trim()}" but registry has ${count}`,
              );
            }
          }
        }
        // Lower bound: "25+ tools" must not exceed actual
        const lower = line.match(/(\d+)\+\s+tools?\b/g);
        if (lower) {
          for (const m of lower) {
            const n = parseInt(m, 10);
            if (n > count) {
              failures.push(
                `${file}:${i + 1}: claims "${m.trim()}" but registry has only ${count}`,
              );
            }
          }
        }
      });
    }

    expect(
      failures,
      failures.length ? "\n" + failures.join("\n") : "all doc tool counts are accurate",
    ).toEqual([]);
  }, 30000); // importing the full tool registry is slow; allow headroom
});
