/**
 * Landing-page onboarding regression tests (source assertions).
 *
 * Everyone — brand-new or returning owner — gets the same flow: splash,
 * then the landing page, then the navbar (Brandon's call, 2026-09-13).
 * This component never redirects anywhere. Its only job:
 *   - wallet owns a page (local storage or on-chain) → nothing. The
 *     owner navigates from the navbar (wallet menu → My Blockpage).
 *   - wallet owns NO page → the skippable first-blockpage wizard shows.
 *
 * Guards:
 *   - zero router usage — no yank, ever, on first load or back-navigation
 *   - existing owners never see a wizard flash (wizard stays hidden while
 *     the on-chain check runs)
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "OnboardingTrigger.tsx"), "utf8");

describe("landing-page onboarding (no redirects)", () => {
  it("never redirects — no router usage at all", () => {
    expect(src).not.toContain("useRouter");
    expect(src).not.toContain("router.replace");
    expect(src).not.toContain("vs_home_redirect_done");
  });

  it("returning owners get nothing — they navigate from the navbar", () => {
    // Locally-remembered published username → hide wizard, no redirect.
    expect(src).toContain("publishedUsername()");
    // On-chain registered username → cached locally, wizard hidden.
    expect(src).toContain("fetchRegisteredUsername");
    expect(src).toContain("markPublished(username)");
  });

  it("new wallets still get the first-blockpage wizard", () => {
    // The no-username branch shows the wizard.
    expect(src).toMatch(/else\s*{\s*\n\s*setVisible\(true\)/);
    expect(src).toContain("<Onboarding onDone=");
  });

  it("wizard stays hidden while the on-chain check runs (no flash)", () => {
    expect(src).toContain("setChecking(true)");
    expect(src).toContain("checking");
  });

  it("still exports markPublished for the builder", () => {
    expect(src).toContain("export function markPublished");
  });
});
