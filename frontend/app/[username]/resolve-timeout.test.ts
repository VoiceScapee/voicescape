/**
 * Blockpage resolve-timeout regression tests (2026-09-29 /ash-rook report).
 *
 * Standing rule: no Voicescape page may hang forever on a stalled request.
 * Every network call on the blockpage load path must have a hard timeout and
 * surface a real error with a retry instead of an endless loading shimmer.
 *
 * Style follows repo convention: source assertions (no jsdom here) plus one
 * behavioral test proving a stalled mirror node resolves to null instead of
 * hanging the /api/resolve ?owner= lookup.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveUsernameForOwner } from "../../lib/registry-reverse";

const here = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(join(here, "page.tsx"), "utf8");
const liveSrc = readFileSync(join(here, "..", "..", "components", "LivestreamBlock.tsx"), "utf8");
const reverseSrc = readFileSync(join(here, "..", "..", "lib", "registry-reverse.ts"), "utf8");

describe("[username] page — resolve fetch can never hang", () => {
  it("passes an AbortSignal to the /api/resolve fetch", () => {
    expect(pageSrc).toMatch(/\/api\/resolve\?username=[\s\S]*?signal:\s*ctrl\.signal/);
  });

  it("aborts the resolve request after 20s", () => {
    expect(pageSrc).toMatch(/setTimeout\(\(\) => ctrl\.abort\(\), 20_000\)/);
  });

  it("shows an honest timeout message instead of hanging on the shimmer", () => {
    expect(pageSrc).toContain("The page took too long to load");
  });

  it("offers a Try again retry on the error state", () => {
    expect(pageSrc).toContain("Try again");
    expect(pageSrc).toMatch(/onClick=\{\(\) => window\.location\.reload\(\)\}/);
  });
});

describe("LivestreamBlock — youtube-live check is bounded", () => {
  it("passes an AbortSignal to the /api/youtube-live fetch", () => {
    expect(liveSrc).toMatch(/\/api\/youtube-live\?channel=[\s\S]*?signal:\s*ctrl\.signal/);
  });

  it("aborts a stalled live-status check after 15s", () => {
    expect(liveSrc).toMatch(/setTimeout\(\(\) => ctrl\.abort\(\), 15_000\)/);
  });

  it("stays offline-first on timeout (no error UI, keeps current badge)", () => {
    expect(liveSrc).toContain("offline-first: keep current status");
  });
});

describe("registry-reverse — mirror fetches are bounded", () => {
  it("routes mirror fetches through a timeout helper", () => {
    expect(reverseSrc).toContain("MIRROR_TIMEOUT_MS");
    expect(reverseSrc).toMatch(/setTimeout\(\(\) => ctrl\.abort\(\), MIRROR_TIMEOUT_MS\)/);
  });

  it("both the account lookup and the contract-results lookup use it", () => {
    const uses = reverseSrc.match(/await mirrorFetch\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  it("a stalled mirror node resolves to null instead of hanging", async () => {
    vi.useFakeTimers();
    const seenSignals: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          seenSignals.push(init?.signal);
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("This operation was aborted", "AbortError"));
          });
        }),
    );
    try {
      const pending = resolveUsernameForOwner("0.0.10424063");
      // Attach early so the abort rejection is never unhandled under fake timers.
      pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toBeNull();
      expect(seenSignals.length).toBeGreaterThan(0);
      expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
