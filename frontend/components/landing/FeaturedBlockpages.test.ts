/**
 * FeaturedBlockpages component regression tests (source assertions, repo convention).
 *
 * The landing page's featured-blockpages section must keep using the
 * landing.featured* i18n keys (no hard-coded English copy), link each card
 * to the real /username page, and render the LIVE pill from the
 * landing.liveBadge key — never a fabricated metric.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "FeaturedBlockpages.tsx"), "utf8");
const pageSrc = readFileSync(join(here, "..", "..", "app", "page.tsx"), "utf8");

describe("FeaturedBlockpages (landing section)", () => {
  it("uses the landing.featured* i18n keys — no hard-coded English copy", () => {
    for (const k of [
      "landing.featuredLabel",
      "landing.featuredSub",
      "landing.featuredFollowers",
      "landing.featuredBadges",
      "landing.liveBadge",
    ]) {
      expect(src, `missing i18n key ${k}`).toContain(k);
    }
  });

  it("links every card to the real /username page", () => {
    expect(src).toContain("href={`/${p.username}`}");
  });

  it("renders nothing while loading or on fetch failure", () => {
    expect(src).toContain("if (!pages) return null;");
  });

  it("shows follower and badge counts from the API — never hardcoded metrics", () => {
    expect(src).toContain("{p.followers}");
    expect(src).toContain("{p.badges.length}");
    expect(src).not.toMatch(/join thousands|trusted by|millions/i);
  });

  it("is mounted on the landing page below the lobby preview", () => {
    expect(pageSrc).toContain("<FeaturedBlockpages />");
    const chatIdx = pageSrc.indexOf("<ChatPreview />");
    const featIdx = pageSrc.indexOf("<FeaturedBlockpages />");
    expect(chatIdx).toBeGreaterThanOrEqual(0);
    expect(featIdx).toBeGreaterThan(chatIdx);
  });
});
