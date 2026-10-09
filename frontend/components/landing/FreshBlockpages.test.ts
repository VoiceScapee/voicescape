/**
 * FreshBlockpages component regression tests (source assertions, repo convention).
 *
 * The landing page's fresh-blockpages section must keep using the
 * landing.fresh* i18n keys (no hard-coded English copy), link each card
 * to the real /username page, mark human vs agent pages honestly from the
 * API's ownerType, and render the NEW pill from the landing.freshNew key —
 * never a fabricated metric.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "FreshBlockpages.tsx"), "utf8");
const pageSrc = readFileSync(join(here, "..", "..", "app", "page.tsx"), "utf8");

describe("FreshBlockpages (landing section)", () => {
  it("uses the landing.fresh* i18n keys — no hard-coded English copy", () => {
    for (const k of [
      "landing.freshLabel",
      "landing.freshSub",
      "landing.freshNew",
      "landing.freshAgent",
      "landing.freshHuman",
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

  it("marks human vs agent from the API ownerType — never hardcoded", () => {
    expect(src).toContain("p.ownerType === 1");
    expect(src).not.toMatch(/join thousands|trusted by|millions/i);
  });

  it("is mounted on the landing page below the lobby preview", () => {
    expect(pageSrc).toContain("<FreshBlockpages />");
    const chatIdx = pageSrc.indexOf("<ChatPreview />");
    const freshIdx = pageSrc.indexOf("<FreshBlockpages />");
    expect(chatIdx).toBeGreaterThanOrEqual(0);
    expect(freshIdx).toBeGreaterThan(chatIdx);
  });

  it("is the only blockpage showcase section on the landing page", () => {
    expect(pageSrc).not.toContain("<FeaturedBlockpages />");
    expect(pageSrc).not.toContain("components/landing/FeaturedBlockpages");
  });
});
