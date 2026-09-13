/**
 * Splash behavior regression tests (source assertions, mirroring the
 * design-system test pattern).
 *
 * The splash is a FIXED full-viewport overlay — not a scrollable part of
 * the landing flow:
 *   - it renders as a fixed overlay that locks page scroll while up
 *   - no scroll cue invites users down; the landing is unreachable until Enter
 *   - only an explicit Enter click dismisses it (no auto-dismiss timer)
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const splash = readFileSync(join(here, "Splash.tsx"), "utf8");

describe("splash scroll behavior", () => {
  it("renders as a fixed overlay covering the viewport", () => {
    expect(splash).toMatch(/position:\s*["']?fixed["']?/);
    expect(splash).toMatch(/inset:\s*0/);
  });

  it("locks page scroll while the splash is up and releases it on enter", () => {
    expect(splash).toMatch(/document\.body\.style\.overflow\s*=\s*["']hidden["']/);
    // cleanup restores the previous overflow value
    expect(splash).toMatch(/document\.body\.style\.overflow\s*=\s*prev/);
  });

  it("offers no scroll cue into the landing content", () => {
    expect(splash).not.toContain("IconChevronDown");
  });

  it("dismisses only on explicit Enter — no auto-dismiss timer", () => {
    expect(splash).toContain("vs_splash_entered");
    expect(splash).toContain("setEntered(true)");
    expect(splash).not.toContain("setTimeout");
    expect(splash).not.toContain("setInterval");
  });

  it("uses the approved logo lockup, not the stale banner asset", () => {
    expect(splash).toContain("/voicescape-logo.webp");
    expect(splash).not.toContain("voicescape-banner");
  });
});
