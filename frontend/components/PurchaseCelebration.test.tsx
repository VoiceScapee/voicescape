/**
 * PurchaseCelebration tests: the post-purchase moment renders the right
 * variant for badge vs. regular listings, stays a pure presentational
 * component (no hooks, no providers needed), and ships reduced-motion CSS.
 *
 * Repo convention for components is source assertions + renderToString
 * (no DOM in this suite).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderToString } from "react-dom/server";
import PurchaseCelebration from "./PurchaseCelebration";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "app", "globals.css"), "utf8");

describe("PurchaseCelebration", () => {
  it("badge variant celebrates the earned badge", () => {
    const html = renderToString(
      <PurchaseCelebration badge={{ icon: "🦕", name: "Bacon Badge" }} title="Bacon Badge" />,
    );
    expect(html).toContain("Badge earned!");
    expect(html).toContain("Bacon Badge");
    expect(html).toContain("now on your blockpage");
    expect(html).toContain("pv-buy-medallion");
    expect(html).toContain('role="status"');
  });

  it("generic variant celebrates the purchase without badge copy", () => {
    const html = renderToString(
      <PurchaseCelebration title="Handmade sticker pack" />,
    );
    expect(html).toContain("It&#x27;s yours!");
    expect(html).toContain("Handmade sticker pack");
    expect(html).toContain("payment confirmed on-chain");
    expect(html).toContain("is-generic");
    expect(html).not.toContain("Badge earned!");
  });

  it("null badge falls back to the generic variant", () => {
    const html = renderToString(
      <PurchaseCelebration badge={null} title="Some listing" />,
    );
    expect(html).toContain("It&#x27;s yours!");
  });

  it("ships reduced-motion CSS for the celebration", () => {
    expect(css).toContain(".pv-buy-celebration");
    expect(css).toContain(".pv-buy-medallion");
    const reduced = css.match(
      /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.pv-buy-celebration[^}]*\}/,
    );
    expect(reduced).not.toBeNull();
  });
});
