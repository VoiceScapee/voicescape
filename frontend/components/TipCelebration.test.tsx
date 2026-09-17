/**
 * TipCelebration regression tests (source assertions, repo convention).
 *
 * Brandon's call 2026-09-13: after a tip or fundraiser donation confirms,
 * the sender should get a special moment — a sound-wave ripple with the
 * tip amount — instead of a boring receipt. Both tips and fundraiser
 * donations flow through TipBox's confirmed state, so one celebration
 * covers both.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const compSrc = readFileSync(join(here, "TipCelebration.tsx"), "utf8");
// Celebration styles live in app/globals.css (shared by the blockpage and
// townhall tip flows), next to the tx-confirm styles.
const cssSrc = readFileSync(join(here, "..", "app", "globals.css"), "utf8");
const pageSrc = readFileSync(join(here, "..", "app", "[username]", "page.tsx"), "utf8");

describe("TipCelebration", () => {
  it("renders staggered ripple rings around a megaphone core", () => {
    expect(compSrc).toContain("pv-ripple-stage");
    expect(compSrc).toMatch(/pv-ripple-ring/g);
    // Three rings, staggered so the wave pulses continuously.
    const delays = compSrc.match(/animationDelay: "([\d.]+)s"/g) ?? [];
    expect(delays.length).toBe(3);
    expect(compSrc).toContain("IconTip");
    expect(compSrc).toContain("pv-ripple-core");
  });

  it("shows the tip amount big with the recipient", () => {
    expect(compSrc).toContain("pv-tip-celebration-amount");
    // The usd prop is a currency-aware display string ("$5.00" or "5 HBAR")
    // — the component must not hardcode a $ prefix.
    expect(compSrc).toContain("{usd}");
    expect(compSrc).not.toMatch(/\$\{usd\}/);
    expect(compSrc).toContain("HBAR");
    expect(compSrc).toMatch(/@\{username\}/);
  });

  it("announces politely for screen readers", () => {
    expect(compSrc).toContain('role="status"');
    expect(compSrc).toContain('aria-live="polite"');
  });
});

describe("celebration styles", () => {
  it("rings expand and fade like a sound wave", () => {
    expect(cssSrc).toContain("@keyframes pvRipple");
    expect(cssSrc).toMatch(/pvRipple[\s\S]*scale\(0\.32\)[\s\S]*scale\(1\.12\)/);
    expect(cssSrc).toMatch(/\.pv-ripple-ring[\s\S]*animation:\s*pvRipple/);
  });

  it("respects reduced motion", () => {
    expect(cssSrc).toMatch(
      /prefers-reduced-motion[\s\S]*\.pv-ripple-ring[\s\S]*animation:\s*none/,
    );
  });
});

describe("TipBox wires the celebration into the confirmed state", () => {
  it("renders TipCelebration above the receipt when the tip confirms", () => {
    const confirmed = pageSrc.indexOf('title="Tip confirmed"');
    const celebration = pageSrc.indexOf("<TipCelebration");
    expect(celebration).toBeGreaterThan(-1);
    expect(celebration).toBeLessThan(confirmed);
    expect(pageSrc).toMatch(
      /<TipCelebration[\s\S]*usd=\{isHbar \?[\s\S]*username=\{username\}/,
    );
  });

  it("does not celebrate the merely-submitted (unconfirmed) state", () => {
    // The submitted branch must stay honest — no celebration before consensus.
    const submitted = pageSrc.indexOf("Tip submitted");
    const celebration = pageSrc.indexOf("<TipCelebration");
    expect(submitted).toBeGreaterThan(-1);
    expect(celebration).toBeLessThan(submitted);
  });
});
