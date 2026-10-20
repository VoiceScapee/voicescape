// Builder stepped flow (2026-10-18): tests for generative template variants.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESIGN_SYSTEM,
  createThemeVariant,
  getTemplateDesign,
  mulberry32,
  seedFromString,
  variantCssVars,
  type TemplateDesignSystem,
  type ThemeVariant,
} from "./template-variants";

const BASE_THEME = {
  background: "#141b29",
  foreground: "#eef2f8",
  accent: "#38bdf8",
  fontFamily: "Arial, Helvetica, sans-serif",
};

const DESIGN: TemplateDesignSystem = {
  fontPairings: [
    "Inter, 'Helvetica Neue', Arial, sans-serif",
    "Georgia, 'Times New Roman', serif",
  ],
  radiusBasePx: 14,
  spacingBasePx: 16,
  hueShiftRange: [-16, 16],
};

/** Test-local hex -> hue parser (the module keeps its color helpers internal). */
function hexHue(hex: string): number {
  let d = hex.replace(/^#/, "");
  if (d.length === 3) d = d.split("").map((c) => c + c).join("");
  const r = parseInt(d.slice(0, 2), 16) / 255;
  const g = parseInt(d.slice(2, 4), 16) / 255;
  const b = parseInt(d.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const dd = max - min;
  let h = 0;
  if (max === r) h = (g - b) / dd + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / dd + 2;
  else h = (r - g) / dd + 4;
  return (h / 6) * 360;
}

/** Signed hue distance in degrees, wraparound-aware. */
function hueDiff(a: number, b: number): number {
  return ((((b - a + 540) % 360) + 360) % 360) - 180;
}

describe("seedFromString", () => {
  it("is stable for the same input", () => {
    expect(seedFromString("hello-blockpage")).toBe(seedFromString("hello-blockpage"));
  });
  it("is distinct for different inputs and fits in uint32", () => {
    const a = seedFromString("page-one");
    const b = seedFromString("page-two");
    expect(a).not.toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(2 ** 32);
    expect(b).toBeLessThan(2 ** 32);
  });
});

describe("mulberry32", () => {
  it("is deterministic for the same seed", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it("emits values in [0, 1)", () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("createThemeVariant", () => {
  it("is deterministic: same inputs -> deep-equal variant", () => {
    const a = createThemeVariant(BASE_THEME, DESIGN, 42);
    const b = createThemeVariant(BASE_THEME, DESIGN, 42);
    expect(a).toEqual(b);
  });

  it("produces at least 8 distinct accents across 10 seeds", () => {
    const accents = new Set<string>();
    for (let s = 0; s < 10; s++) {
      accents.add(createThemeVariant(BASE_THEME, DESIGN, s * 7919).accent);
    }
    expect(accents.size).toBeGreaterThanOrEqual(8);
  });

  it("keeps the accent hue shift within the design's hueShiftRange", () => {
    const baseHue = hexHue(BASE_THEME.accent);
    const [lo, hi] = DESIGN.hueShiftRange;
    for (let s = 0; s < 25; s++) {
      const v = createThemeVariant(BASE_THEME, DESIGN, s * 104729);
      const shift = hueDiff(baseHue, hexHue(v.accent));
      expect(shift).toBeGreaterThanOrEqual(lo - 1);
      expect(shift).toBeLessThanOrEqual(hi + 1);
    }
  });

  it("shifts the background hue by a smaller amount than the accent", () => {
    const baseAccentHue = hexHue(BASE_THEME.accent);
    const baseBgHue = hexHue(BASE_THEME.background);
    let sawDifference = false;
    for (let s = 0; s < 25; s++) {
      const v = createThemeVariant(BASE_THEME, DESIGN, s * 104729);
      const accentShift = Math.abs(hueDiff(baseAccentHue, hexHue(v.accent)));
      const bgShift = Math.abs(hueDiff(baseBgHue, hexHue(v.background)));
      expect(bgShift).toBeLessThanOrEqual(accentShift + 2);
      if (accentShift > 1) sawDifference = true;
    }
    expect(sawDifference).toBe(true);
  });

  it("stays inside the radius/spacing/angle ranges", () => {
    for (let s = 0; s < 50; s++) {
      const v: ThemeVariant = createThemeVariant(BASE_THEME, DESIGN, s);
      expect(v.radiusPx).toBeGreaterThanOrEqual(10);
      expect(v.radiusPx).toBeLessThanOrEqual(26);
      expect(v.spacingPx).toBeGreaterThanOrEqual(12);
      expect(v.spacingPx).toBeLessThanOrEqual(22);
      expect(v.gradientAngle).toBeGreaterThanOrEqual(0);
      expect(v.gradientAngle).toBeLessThan(360);
      expect(DESIGN.fontPairings).toContain(v.fontFamily);
      expect(v.seed).toBe(s >>> 0);
    }
  });

  it("passes non-hex backgrounds (gradients) through unchanged", () => {
    const gradient = "linear-gradient(180deg, #0b0b10 0%, #141419 100%)";
    const v = createThemeVariant({ ...BASE_THEME, background: gradient }, DESIGN, 9);
    expect(v.background).toBe(gradient);
  });
});

describe("variantCssVars", () => {
  it("returns the three expected keys with px/deg units", () => {
    const v = createThemeVariant(BASE_THEME, DESIGN, 5);
    const vars = variantCssVars(v);
    expect(Object.keys(vars).sort()).toEqual([
      "--pv-gradient-angle",
      "--pv-radius",
      "--pv-spacing",
    ]);
    expect(vars["--pv-radius"]).toBe(`${v.radiusPx}px`);
    expect(vars["--pv-spacing"]).toBe(`${v.spacingPx}px`);
    expect(vars["--pv-gradient-angle"]).toBe(`${v.gradientAngle}deg`);
  });
});

describe("getTemplateDesign", () => {
  it("returns the template's own design when present", () => {
    expect(getTemplateDesign({ theme: BASE_THEME, design: DESIGN })).toBe(DESIGN);
  });

  it("accepts a full Template (theme nested under page)", () => {
    const template = {
      id: "x",
      name: "X",
      description: "x",
      category: "personal" as const,
      design: DESIGN,
      page: { version: 1, username: "x", theme: BASE_THEME, blocks: [] },
    };
    expect(getTemplateDesign(template)).toBe(DESIGN);
    const { design: _omit, ...noDesign } = template;
    void _omit;
    const d = getTemplateDesign(noDesign);
    expect(d.fontPairings).toEqual([BASE_THEME.fontFamily]);
  });

  it("falls back to DEFAULT with the theme's own fontFamily", () => {
    const d = getTemplateDesign({ theme: BASE_THEME });
    expect(d).toEqual({ ...DEFAULT_DESIGN_SYSTEM, fontPairings: [BASE_THEME.fontFamily] });
    expect(d.fontPairings).toEqual([BASE_THEME.fontFamily]);
  });
});
