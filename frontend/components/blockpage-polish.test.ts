/**
 * Blockpage surface polish tests (source assertions, repo convention).
 *
 * Covers the audit fixes: no fabricated numbers on failed fetches, no
 * loading-state flashes, unique tab ids, lazy gallery images, dead-link
 * filtering, and the trackless-music honesty rule.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const rendererSrc = readFileSync(join(here, "PageRenderer.tsx"), "utf8");
const referralSrc = readFileSync(join(here, "townhall", "ReferralCard.tsx"), "utf8");
const goalSrc = readFileSync(join(here, "GoalBar.tsx"), "utf8");

describe("blockpage surface polish", () => {
  it("ReferralCard never fabricates a zero on API failure", () => {
    // The catch must not invent stats — failure is "unknown", not "none".
    expect(referralSrc).not.toMatch(/setStats\(\{\s*username,\s*totalReferrals:\s*0/);
    expect(referralSrc).toContain("setFailed(true)");
    expect(referralSrc).toMatch(/stats unavailable/);
  });

  it("GoalBar renders nothing while the on-chain total is loading", () => {
    expect(goalSrc).toContain("loading");
    expect(goalSrc).toMatch(/if\s*\(\s*loading\s*\)\s*return null/);
  });

  it("TabsBlock prefixes tab ids so two tab blocks never collide", () => {
    expect(rendererSrc).toContain("useId()");
    expect(rendererSrc).toContain("pv-tab-${uid}");
    expect(rendererSrc).toContain("pv-tabpanel-${uid}");
  });

  it("gallery images lazy-load (hero avatar stays eager)", () => {
    expect(rendererSrc).toContain('loading="lazy"');
    // The hero avatar img has no loading attr — above the fold, stays eager.
    const heroImg = rendererSrc.match(/pv-avatar"[\s\S]{0,400}?<img[\s\S]*?>/);
    expect(heroImg?.[0] ?? "").not.toContain("loading=");
  });

  it("link buttons with rejected URLs are filtered, not rendered dead", () => {
    expect(rendererSrc).toContain(".filter((item) => safeExternalUrl(item.url)");
    expect(rendererSrc).not.toContain("href={url ?? undefined}");
  });

  it("trackless music blocks with no user text render an honest empty state", () => {
    expect(rendererSrc).toMatch(/if \(tracks\.length === 0\)/);
    expect(rendererSrc).toMatch(/No tracks added yet/);
  });

  it("gallery tiles are perceivable (no blanket aria-hidden)", () => {
    expect(rendererSrc).not.toMatch(/pv-gallery-"[^}]*aria-hidden="true"/);
    // Only the marquee's duplicate strip is hidden from assistive tech.
    expect(rendererSrc).toContain("duplicate half from assistive tech");
  });
});
