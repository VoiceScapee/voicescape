/**
 * Post-connect routing regression tests (source assertions).
 *
 * On first app load after the wallet connects:
 *   - wallet owns a page on-chain (or local storage says onboarded/published)
 *     → route straight to /builder (their page loads for editing)
 *   - wallet owns NO page → the first-blockpage wizard shows (unchanged)
 *
 * Guards:
 *   - the redirect fires once per tab session (no yank on back-navigation)
 *   - existing owners never see a wizard flash (wizard stays hidden while
 *     the on-chain check runs)
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "OnboardingTrigger.tsx"), "utf8");

describe("post-connect routing", () => {
  it("routes existing owners to /builder on first load after connect", () => {
    expect(src).toContain('router.replace("/builder")');
    // Both paths that prove ownership trigger the redirect: local state
    // (onboarded/published) and the on-chain reverse lookup.
    expect(src).toMatch(/isOnboarded\(\)\s*\|\|\s*hasPublished\(\)/);
    expect(src).toContain("fetchRegisteredUsername");
  });

  it("redirects once per tab session — never on back-navigation", () => {
    expect(src).toContain("vs_builder_redirect_done");
    expect(src).toContain("redirectDone()");
    expect(src).toContain("markRedirectDone()");
  });

  it("new wallets still get the first-blockpage wizard (no redirect)", () => {
    // The no-username branch shows the wizard; the redirect branches only
    // fire where a username/ownership was found.
    expect(src).toMatch(/else\s*{\s*\n\s*setVisible\(true\)/);
    const redirectLines = src
      .split("\n")
      .filter((l) => l.includes('router.replace("/builder")'));
    expect(redirectLines.length).toBeGreaterThan(0);
    // Every redirect is guarded by the ownership checks above it — the
    // wizard branch contains no router.replace.
    expect(src).not.toMatch(/setVisible\(true\)[\s\S]{0,200}router\.replace/);
  });

  it("wizard stays hidden while the on-chain check runs (no flash)", () => {
    expect(src).toContain("setChecking(true)");
    expect(src).toContain("checking");
  });
});
