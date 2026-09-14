import { describe, expect, it } from "vitest";
import {
  GRADIENT_PRESETS,
  GRADIENT_DIRECTIONS,
  DEFAULT_SOLID_BACKGROUND,
  backgroundMode,
  buildCustomGradient,
  findGradientPreset,
  isGradient,
} from "./theme-presets";
import { TEMPLATES } from "./templates";
import { isValidPage, type VoicescapePage } from "./schema";
import { checkContent } from "./server/townhall/content-filter";

describe("isGradient", () => {
  it("rejects solid colors", () => {
    expect(isGradient("#141b29")).toBe(false);
    expect(isGradient("#ffffff")).toBe(false);
    expect(isGradient("red")).toBe(false);
    expect(isGradient("")).toBe(false);
  });
  it("detects every gradient flavor", () => {
    expect(isGradient("linear-gradient(180deg, #000, #fff)")).toBe(true);
    expect(isGradient("radial-gradient(ellipse at center, #000, #fff)")).toBe(true);
    expect(isGradient("repeating-linear-gradient(0deg, red 0 1px, transparent 1px 4px)")).toBe(true);
    expect(isGradient("repeating-radial-gradient(circle, red, blue)")).toBe(true);
    expect(isGradient("conic-gradient(red, blue)")).toBe(true);
    expect(isGradient("LINEAR-GRADIENT(180deg, #000, #fff)")).toBe(true);
  });
});

describe("backgroundMode", () => {
  it("routes solids and gradients to the right editor", () => {
    expect(backgroundMode("#141b29")).toBe("solid");
    expect(backgroundMode("linear-gradient(180deg, #000, #fff)")).toBe("gradient");
    expect(backgroundMode("")).toBe("solid");
  });
});

describe("GRADIENT_PRESETS", () => {
  it("ships 8 presets with unique ids, all valid gradients", () => {
    expect(GRADIENT_PRESETS.length).toBe(8);
    const ids = GRADIENT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of GRADIENT_PRESETS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(isGradient(p.css)).toBe(true);
    }
  });
  it("covers every gradient shipped in the gallery templates exactly", () => {
    const templateGradients = TEMPLATES.map((t) => t.page.theme.background).filter(isGradient);
    expect(templateGradients.length).toBeGreaterThan(0);
    for (const css of templateGradients) {
      expect(findGradientPreset(css), `no preset matches template gradient: ${css.slice(0, 60)}…`).toBeDefined();
    }
  });
  it("matches despite whitespace differences", () => {
    const p = GRADIENT_PRESETS[0];
    expect(findGradientPreset(p.css.replace(/, /g, ",\n  ")))?.toBe(p);
  });
  it("returns undefined for unknown gradients", () => {
    expect(findGradientPreset("linear-gradient(180deg, #123456, #654321)")).toBeUndefined();
  });
});

describe("buildCustomGradient", () => {
  it("builds linear gradients for the three angles", () => {
    expect(buildCustomGradient("#111111", "#222222", "180deg")).toBe(
      "linear-gradient(180deg, #111111 0%, #222222 100%)",
    );
    expect(buildCustomGradient("#111111", "#222222", "90deg")).toBe(
      "linear-gradient(90deg, #111111 0%, #222222 100%)",
    );
    expect(buildCustomGradient("#111111", "#222222", "135deg")).toBe(
      "linear-gradient(135deg, #111111 0%, #222222 100%)",
    );
  });
  it("builds a radial gradient", () => {
    expect(buildCustomGradient("#111111", "#222222", "radial")).toBe(
      "radial-gradient(ellipse at center, #111111 0%, #222222 100%)",
    );
  });
  it("offers exactly the four directions the panel renders", () => {
    expect(GRADIENT_DIRECTIONS.map((d) => d.id).sort()).toEqual(
      ["135deg", "180deg", "90deg", "radial"].sort(),
    );
  });
  it("custom output round-trips as a gradient with no preset match", () => {
    const css = buildCustomGradient("#7c3aed", "#db2777", "135deg");
    expect(backgroundMode(css)).toBe("gradient");
    expect(findGradientPreset(css)).toBeUndefined(); // panel shows "Custom"
  });
});

describe("solid <-> gradient switching never corrupts the value", () => {
  // Mirrors the ThemeEditor's remember-each-side logic: the stored background
  // is only ever replaced by the remembered value of the other mode.
  it("toggling preserves both sides", () => {
    const solid = "#141b29";
    const gradient = GRADIENT_PRESETS[1].css;
    let background = solid;
    const lastSolid = { current: solid };
    const lastGradient = { current: gradient };
    const setMode = (m: "solid" | "gradient") => {
      background = m === "gradient" ? lastGradient.current : lastSolid.current;
    };
    setMode("gradient");
    expect(background).toBe(gradient);
    lastGradient.current = buildCustomGradient("#aaaaaa", "#bbbbbb", "90deg");
    setMode("solid");
    expect(background).toBe(solid);
    setMode("gradient");
    expect(background).toBe("linear-gradient(90deg, #aaaaaa 0%, #bbbbbb 100%)");
    expect(backgroundMode(background)).toBe("gradient");
  });
  it("has a sane solid fallback when the stored value is unusable", () => {
    expect(isGradient(DEFAULT_SOLID_BACKGROUND)).toBe(false);
    expect(/^#[0-9a-fA-F]{6}$/.test(DEFAULT_SOLID_BACKGROUND)).toBe(true);
  });
});

describe("gradients survive the publish path", () => {
  const pageWith = (background: string): VoicescapePage => ({
    version: 1,
    username: "gradient-test",
    theme: { background, foreground: "#f5f2ea", accent: "#ff6b35", fontFamily: "Georgia, serif" },
    blocks: [{ type: "hero", title: "hi" }],
  });
  it("schema validation accepts gradient backgrounds", () => {
    for (const p of GRADIENT_PRESETS) {
      expect(isValidPage(pageWith(p.css))).toBe(true);
    }
    expect(isValidPage(pageWith(buildCustomGradient("#111111", "#222222", "radial")))).toBe(true);
  });
  it("the pin content filter does not block gradient strings", () => {
    for (const p of GRADIENT_PRESETS) {
      const check = checkContent(p.css, "page content");
      expect(check.allowed, `${p.id} blocked: ${check.reason}`).toBe(true);
    }
  });
});
