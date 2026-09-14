/**
 * Curated background gradient presets for the builder's Theme panel.
 *
 * The preset CSS strings are the EXACT gradients shipped in the gallery
 * templates (aurora-drift, founder, night-signal, lofi-room, solarpunk-garden,
 * wanderer-atlas, block-explorer), so a user can one-tap the look they saw in
 * the template picker — plus one extra curated preset for good measure.
 *
 * Pure and dependency-free (unit-tested).
 */

export interface ThemePreset {
  id: string;
  name: string;
  /** Full CSS `background` value. */
  css: string;
}

export const GRADIENT_PRESETS: ThemePreset[] = [
  {
    id: "aurora-drift",
    name: "Aurora Drift",
    css: "radial-gradient(ellipse 55% 40% at 15% 25%, rgba(94,234,212,0.28), transparent 70%), radial-gradient(ellipse 60% 45% at 85% 40%, rgba(167,139,250,0.32), transparent 70%), radial-gradient(ellipse 50% 40% at 50% 85%, rgba(236,72,153,0.22), transparent 70%), linear-gradient(180deg, #060a24 0%, #0b1035 100%)",
  },
  {
    id: "midnight-fade",
    name: "Midnight Fade",
    css: "linear-gradient(180deg, #0b0b10 0%, #141419 100%)",
  },
  {
    id: "terminal-scan",
    name: "Terminal Scan",
    css: "repeating-linear-gradient(0deg, rgba(74,222,128,0.04) 0 1px, transparent 1px 4px), linear-gradient(180deg, #04070d 0%, #0a0f1a 100%)",
  },
  {
    id: "lamplight",
    name: "Lamplight",
    css: "radial-gradient(ellipse 60% 45% at 50% 110%, rgba(245,158,11,0.25), transparent 70%), linear-gradient(180deg, #241407 0%, #3a2110 55%, #1c1008 100%)",
  },
  {
    id: "garden-sunrise",
    name: "Garden Sunrise",
    css: "radial-gradient(ellipse 70% 50% at 50% -10%, rgba(253,224,71,0.3), transparent 70%), radial-gradient(ellipse 45% 40% at 12% 80%, rgba(163,230,53,0.18), transparent 70%), linear-gradient(180deg, #1d3a1f 0%, #2c5a2e 60%, #16281a 100%)",
  },
  {
    id: "night-signal",
    name: "Night Signal",
    css: "radial-gradient(ellipse 50% 35% at 50% 30%, rgba(248,113,113,0.16), transparent 70%), repeating-linear-gradient(90deg, rgba(248,113,113,0.05) 0 2px, transparent 2px 7px), linear-gradient(180deg, #120607 0%, #1e0a0c 60%, #0b0505 100%)",
  },
  {
    id: "horizon",
    name: "Horizon",
    css: "radial-gradient(ellipse 80% 45% at 50% 108%, rgba(251,146,60,0.35), transparent 70%), linear-gradient(180deg, #101c2e 0%, #274060 55%, #3d2b1f 100%)",
  },
  {
    id: "neon-dusk",
    name: "Neon Dusk",
    css: "linear-gradient(135deg, #7c3aed 0%, #db2777 55%, #f59e0b 100%)",
  },
];

/** True when a theme background value is a CSS gradient rather than a solid color. */
export function isGradient(value: string): boolean {
  return /(?:repeating-linear|repeating-radial|linear|radial|conic)-gradient\s*\(/i.test(
    (value || "").trim(),
  );
}

export type BackgroundMode = "solid" | "gradient";

/** Which editor the Theme panel should show for a background value. */
export function backgroundMode(value: string): BackgroundMode {
  return isGradient(value) ? "gradient" : "solid";
}

/** Collapse whitespace so preset matching survives formatting differences. */
function normalizeCss(css: string): string {
  return (css || "").replace(/\s+/g, " ").trim();
}

/** Find the preset whose css matches (whitespace-insensitive), if any. */
export function findGradientPreset(css: string): ThemePreset | undefined {
  const n = normalizeCss(css);
  return GRADIENT_PRESETS.find((p) => normalizeCss(p.css) === n);
}

export type GradientDirection = "180deg" | "90deg" | "135deg" | "radial";

export const GRADIENT_DIRECTIONS: { id: GradientDirection; label: string }[] = [
  { id: "180deg", label: "Top to bottom" },
  { id: "90deg", label: "Left to right" },
  { id: "135deg", label: "Diagonal" },
  { id: "radial", label: "Radial glow" },
];

/**
 * Build a CSS background string from the custom gradient builder inputs.
 * Colors are `#rrggbb` from `<input type="color">`.
 */
export function buildCustomGradient(
  from: string,
  to: string,
  direction: GradientDirection,
): string {
  if (direction === "radial") {
    return `radial-gradient(ellipse at center, ${from} 0%, ${to} 100%)`;
  }
  return `linear-gradient(${direction}, ${from} 0%, ${to} 100%)`;
}

/** Default solid background when switching back from a gradient. */
export const DEFAULT_SOLID_BACKGROUND = "#141b29";
