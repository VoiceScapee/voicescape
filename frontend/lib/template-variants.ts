// Builder stepped flow (2026-10-18): generative template variants.
// Each new blockpage gets a seeded, unique visual variant of its template —
// design systems, not fixed layouts. All randomness comes from mulberry32
// seeded per page, so variants are deterministic (same seed -> same look).

/** A single seeded visual variant of a template's theme. */
export interface ThemeVariant {
  /** uint32 seed this variant was generated from. */
  seed: number;
  /** hex accent, hue-shifted from the template accent. */
  accent: string;
  /** hex background, subtly shifted from the template background. */
  background: string;
  /** One of the design system's font pairings. */
  fontFamily: string;
  /** 10..26 */
  radiusPx: number;
  /** 12..22 */
  spacingPx: number;
  /** 0..359 */
  gradientAngle: number;
}

/**
 * The design system for one template: the aesthetic boundaries every
 * generated variant must stay inside. Stored on the template as
 * `Template.design`.
 */
export interface TemplateDesignSystem {
  /** 2-4 font stacks within the template's aesthetic. */
  fontPairings: string[];
  radiusBasePx: number;
  spacingBasePx: number;
  /** Degrees of accent hue shift, e.g. [-24, 24]. */
  hueShiftRange: [number, number];
}

/**
 * Builder stepped flow (2026-10-18): fallback design system used when a
 * template has no explicit design — getTemplateDesign overrides
 * fontPairings with the template's own fontFamily.
 */
export const DEFAULT_DESIGN_SYSTEM: TemplateDesignSystem = {
  fontPairings: [
    "system-ui, -apple-system, 'Segoe UI', sans-serif",
    "Georgia, 'Times New Roman', serif",
    "ui-monospace, SFMono-Regular, Menlo, monospace",
  ],
  radiusBasePx: 18,
  spacingBasePx: 17,
  hueShiftRange: [-20, 20],
};

/** Builder stepped flow (2026-10-18): FNV-1a -> uint32. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Builder stepped flow (2026-10-18): seeded PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builder stepped flow (2026-10-18): return the template's design system.
 * Accepts the {theme, design} shape as well as a full Template (theme
 * nested under page) — the builder passes Templates directly.
 */
export function getTemplateDesign(t: {
  theme?: { fontFamily: string };
  page?: { theme: { fontFamily: string } };
  design?: TemplateDesignSystem;
}): TemplateDesignSystem {
  if (t.design) return t.design;
  const fontFamily = t.theme?.fontFamily ?? t.page?.theme.fontFamily ?? "";
  return { ...DEFAULT_DESIGN_SYSTEM, fontPairings: [fontFamily] };
}

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  let digits = m[1];
  if (digits.length === 3) digits = digits.split("").map((c) => c + c).join("");
  const r = parseInt(digits.slice(0, 2), 16) / 255;
  const g = parseInt(digits.slice(2, 4), 16) / 255;
  const b = parseInt(digits.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) { r = c; g = x; }
  else if (hue < 120) { r = x; g = c; }
  else if (hue < 180) { g = c; b = x; }
  else if (hue < 240) { g = x; b = c; }
  else if (hue < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const toByte = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

/**
 * Builder stepped flow (2026-10-18): shift a hex color's hue by `degrees`.
 * Non-hex colors (gradients etc.) pass through unchanged.
 */
function shiftHue(color: string, degrees: number): string {
  const hsl = hexToHsl(color);
  if (!hsl) return color;
  return hslToHex(hsl.h + degrees, hsl.s, hsl.l);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Builder stepped flow (2026-10-18): generate a deterministic visual variant.
 * Same (theme, design, seed) -> identical variant.
 */
export function createThemeVariant(
  baseTheme: {
    background: string;
    foreground: string;
    accent: string;
    fontFamily: string;
  },
  design: TemplateDesignSystem,
  seed: number,
): ThemeVariant {
  const rand = mulberry32(seed >>> 0);
  const [lo, hi] = design.hueShiftRange;
  const hueShift = lo + rand() * (hi - lo);
  const fonts = design.fontPairings.length > 0 ? design.fontPairings : [baseTheme.fontFamily];
  return {
    seed: seed >>> 0,
    accent: shiftHue(baseTheme.accent, hueShift),
    background: shiftHue(baseTheme.background, hueShift / 3),
    fontFamily: fonts[Math.floor(rand() * fonts.length)],
    radiusPx: clamp(Math.round(design.radiusBasePx + (rand() * 2 - 1) * 8), 10, 26),
    spacingPx: clamp(Math.round(design.spacingBasePx + (rand() * 2 - 1) * 5), 12, 22),
    gradientAngle: Math.floor(rand() * 360),
  };
}

/**
 * Builder stepped flow (2026-10-18): CSS custom properties for a variant.
 */
export function variantCssVars(v: ThemeVariant): Record<string, string> {
  return {
    "--pv-radius": `${v.radiusPx}px`,
    "--pv-spacing": `${v.spacingPx}px`,
    "--pv-gradient-angle": `${v.gradientAngle}deg`,
  };
}
