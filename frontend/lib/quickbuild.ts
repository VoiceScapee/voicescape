/**
 * Quick-build (2026-09-29): one-tap "design my page from my links" and the
 * onboarding-socials prefill.
 *
 * First-principles: the highest-leverage AI prompt is already sitting in the
 * page state — the user's pasted socials. The pure helpers below turn page
 * state into the instruction string; the button in VibecodeChat sends it
 * through the EXISTING send path (x402 pay-per-edit or BYOK), so the $0.25
 * economics and the wallet gate are unchanged. No free / server-paid path
 * is created.
 */
import type { VoicescapePage } from "./schema";
import { detectPlatform } from "./socials";

/** Cap mirrors the socials editor (SocialsEditor, Onboarding). */
export const QUICKBUILD_MAX_URLS = 12;

/** Every socials-block URL on the page, in order, deduped. */
export function socialsUrls(page: VoicescapePage): string[] {
  const urls: string[] = [];
  for (const b of page.blocks) {
    if (b.type !== "socials" || !Array.isArray(b.items)) continue;
    for (const it of b.items) {
      const url = typeof it.url === "string" ? it.url.trim() : "";
      if (url && !urls.includes(url)) urls.push(url);
    }
  }
  return urls.slice(0, QUICKBUILD_MAX_URLS);
}

/**
 * Build the one-tap instruction from page state. Pure — unit-tested.
 * Reads exactly like a user-typed prompt so the AI service needs no changes.
 */
export function buildDesignFromLinksInstruction(page: VoicescapePage): string {
  const name = page.username.trim() || "my blockpage";
  const urls = socialsUrls(page);
  const profiles = urls.length > 0 ? urls.join(", ") : "my social profiles";
  return (
    `Design a complete, great-looking blockpage for '${name}'. ` +
    `Base it on these social profiles: ${profiles}. ` +
    `Keep my socials row, add hero/bio/tip jar/music blocks as fits, one cohesive theme.`
  );
}

/**
 * Merge onboarding-pasted socials into a page: fill the first socials block
 * (merged with any template items, deduped, capped at 12), or insert a new
 * socials block after the hero when the template has none. Pure —
 * unit-tested; the builder effect calls this on draft consumption.
 */
export function applyOnboardSocials(page: VoicescapePage, socials: unknown): VoicescapePage {
  const pasted = Array.from(
    new Set(
      (Array.isArray(socials) ? socials : []).filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      ),
    ),
  ).slice(0, QUICKBUILD_MAX_URLS);
  if (pasted.length === 0) return page;
  const items = pasted.map((url) => ({ platform: detectPlatform(url), url }));
  let filled = false;
  const blocks = page.blocks.map((b) => {
    if (!filled && b.type === "socials") {
      filled = true;
      const existing = Array.isArray(b.items) ? b.items : [];
      const merged = [
        ...existing,
        ...items.filter((it) => !existing.some((e) => e.url === it.url)),
      ].slice(0, QUICKBUILD_MAX_URLS);
      return { ...b, items: merged };
    }
    return b;
  });
  if (!filled) {
    const heroIdx = blocks.findIndex((b) => b.type === "hero");
    const socialsBlock = { type: "socials" as const, items };
    const next =
      heroIdx >= 0
        ? [...blocks.slice(0, heroIdx + 1), socialsBlock, ...blocks.slice(heroIdx + 1)]
        : [socialsBlock, ...blocks];
    return { ...page, blocks: next };
  }
  return { ...page, blocks };
}
