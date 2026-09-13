/**
 * Splash behavior regression tests (source assertions, mirroring the
 * design-system test pattern).
 *
 * The splash is the first viewport of a SCROLLABLE landing flow:
 *   - it renders in normal page flow (no fixed overlay trapping scroll)
 *   - a scroll cue invites users down into the landing content
 *   - only an explicit Enter click dismisses it (no auto-dismiss timer)
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const splash = readFileSync(join(here, "Splash.tsx"), "utf8");

describe("splash scroll behavior", () => {
  it("renders in normal page flow — never a fixed overlay", () => {
    expect(splash).not.toMatch(/position:\s*["']?fixed["']?/);
  });

  it("shows a scroll cue inviting users down into the landing content", () => {
    expect(splash).toContain("IconChevronDown");
    expect(splash).toMatch(/scroll/i);
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
