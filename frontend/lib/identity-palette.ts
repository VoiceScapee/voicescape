/**
 * Deterministic identity palettes — the "sorting colors" system.
 *
 * Every blockpage and agent gets a palette computed ONLY from its own
 * on-chain identity data (username / account ID / registry entry). Same
 * identity in → same palette out, forever. The technique (deterministic
 * data→color mapping) is generic generative-art practice, reimplemented
 * here from scratch — no SortingColors artwork, palette, or brand is
 * copied; their specific art is never used.
 *
 * The hues are constrained INSIDE Hedera's official brand family
 * (brand.hedera.com): Cobalt #2D84EB (~210°) → Azure #0031FF (~228°) →
 * Violet #4F46E5 (~243°) → Ultraviolet #8259EF (~258°). Humans sit at
 * the violet/ultraviolet end, AI agents at the cobalt/azure end, so the
 * two communities read apart at a glance while every color stays
 * on-brand.
 *
 * RULE: color always answers "which identity / which activity / how
 * recent" — never decoration, never simulated activity. Quiet states
 * stay quiet; unknown identities get no tint (fail-closed).
 */

import type { CSSProperties } from "react";

export type IdentityOwnerType = "human" | "agent";

export interface IdentityPalette {
  /** Main accent (HSL, readable on dark surfaces). */
  primary: string;
  /** Darker gradient end, same hue family. */
  secondary: string;
  /** Translucent wash for card backgrounds / chips. */
  soft: string;
  /** Glow for rings, pulses, shadows. */
  glow: string;
  /** CSS gradient from primary to secondary. */
  gradient: string;
  /** Hue in degrees, for tests and debugging. */
  hue: number;
}

/** Community band colors — used where only the owner type is known
 *  (e.g. a registry log whose username is an indexed hash on-chain):
 *  Ultraviolet for humans, Cobalt for AI agents. */
export const IDENTITY_BAND: Record<IdentityOwnerType, string> = {
  human: "#8259EF",
  agent: "#2D84EB",
};

/** Hue bands inside Hedera's palette family. */
const BANDS: Record<IdentityOwnerType, [number, number]> = {
  human: [243, 261], // Violet → Ultraviolet
  agent: [208, 230], // Cobalt → Azure
};

/** FNV-1a 32-bit — small, deterministic, no dependency. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Pure function: identity seed + owner type → palette. Deterministic
 * across renders, sessions, and devices. The seed should be the stable
 * on-chain identity (username for cards/avatars; account ID where the
 * username is unavailable). Never seed from timestamps or random data.
 */
export function identityPalette(
  seed: string,
  ownerType: IdentityOwnerType,
): IdentityPalette {
  const [lo, hi] = BANDS[ownerType];
  const hash = fnv1a(`${ownerType}:${seed}`);
  const span = hi - lo;
  // Two independent slices of the hash: hue position + lightness nuance.
  const hue = lo + (hash % (span + 1));
  const light = 62 + ((hash >>> 8) % 9); // 62–70% — always readable on dark
  const primary = `hsl(${hue}, 88%, ${light}%)`;
  const secondary = `hsl(${Math.max(200, hue - 10)}, 90%, 46%)`;
  return {
    primary,
    secondary,
    soft: `hsla(${hue}, 88%, ${light}%, 0.14)`,
    glow: `hsla(${hue}, 88%, ${light}%, 0.45)`,
    gradient: `linear-gradient(135deg, ${primary}, ${secondary})`,
    hue,
  };
}

/** CSS custom properties for a palette — set inline on a card/avatar. */
export function identityCssVars(palette: IdentityPalette): CSSProperties {
  return {
    "--id-primary": palette.primary,
    "--id-secondary": palette.secondary,
    "--id-soft": palette.soft,
    "--id-glow": palette.glow,
    "--id-gradient": palette.gradient,
  } as CSSProperties;
}

/**
 * Decode the registry owner type from a PageRegistered log's `data`
 * field (2nd 32-byte word: 0 = HUMAN, 1 = AGENT — same layout the
 * /api/agents/directory route decodes). Returns null when the data is
 * missing, short, or holds any other value: callers must fall back to
 * the neutral color, never guess a community.
 */
export function decodeOwnerTypeFromLogData(
  data: unknown,
): IdentityOwnerType | null {
  if (typeof data !== "string") return null;
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.length < 128) return null;
  const word = parseInt(hex.slice(64, 128), 16);
  if (word === 0) return "human";
  if (word === 1) return "agent";
  return null;
}
