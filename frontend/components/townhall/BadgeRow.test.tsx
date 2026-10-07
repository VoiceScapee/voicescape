/**
 * BadgeRow tests (source assertions, repo convention).
 *
 * Purchased badges (category "purchased") must be visually distinct from
 * earned achievement/referral badges: amber/gold treatment vs the purple
 * earned treatment, plus an "Owned" marker so a buyer can tell at a glance
 * which badges were bought on-chain and which were earned.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "BadgeRow.tsx"), "utf8");

describe("BadgeRow", () => {
  it("gives purchased badges a distinct amber treatment", () => {
    // The category gate drives the styling.
    expect(src).toMatch(/b\.category\s*===\s*"purchased"/);
    // Amber background/border vs the purple earned treatment.
    expect(src).toContain("255,193,7");
    expect(src).toContain("130,89,239");
  });

  it("marks purchased badges with an Owned label", () => {
    expect(src).toMatch(/>\s*Owned\s*</);
  });

  it("keeps the earned badge styling unchanged", () => {
    // Non-purchased badges keep the existing purple chip.
    expect(src).toContain("#c6cfff");
    expect(src).toContain("#ffe1a1");
  });
});
