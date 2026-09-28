/**
 * BringCryptoChecklist regression tests (source assertions, repo convention).
 *
 * Brandon's call 2026-09-28: make the "use what you hold" flow dead simple.
 * When a visitor opens Token mode with an empty wallet, the tip panel shows
 * a plain-words 3-step checklist (bridge -> associate -> keep HBAR for gas)
 * instead of a dead end. The dapp never bridges itself — it links out.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const compSrc = readFileSync(join(here, "BringCryptoChecklist.tsx"), "utf8");
const pageSrc = readFileSync(join(here, "..", "app", "[username]", "page.tsx"), "utf8");

describe("BringCryptoChecklist", () => {
  it("shows a plain-words heading and intro", () => {
    expect(compSrc).toContain("Bring your crypto to Hedera");
    expect(compSrc).toContain("Three quick steps");
  });

  it("lists the three steps: bridge, associate, keep HBAR", () => {
    expect(compSrc).toContain("Move it to Hedera");
    expect(compSrc).toContain("Tap to receive it");
    expect(compSrc).toContain("Keep about $1 of HBAR");
  });

  it("links out to SaucerSwap's bridge in a new tab, never bridges in-dapp", () => {
    expect(compSrc).toContain("https://www.saucerswap.finance/bridge");
    expect(compSrc).toContain('target="_blank"');
    expect(compSrc).toContain('rel="noopener noreferrer"');
  });

  it("mentions the HBAR gas fee and the 98% creator split", () => {
    expect(compSrc).toContain("network fee");
    expect(compSrc).toContain("HBAR");
    expect(compSrc).toContain("98%");
  });

  it("uses no crypto jargon a beginner wouldn't know", () => {
    // Strip code comments: the research basis may name protocols, but the
    // user-visible copy must stay in plain words.
    const copy = compSrc.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const jargon of ["CCTP", "HashPort", "slippage", "liquidity", "mempool", "gasless"]) {
      expect(copy).not.toContain(jargon);
    }
  });

  it("is rendered by the tip panel when Token mode finds no tokens", () => {
    expect(pageSrc).toContain("BringCryptoChecklist");
    // The empty-wallet branch renders the checklist (not just a dead-end line).
    expect(pageSrc).toMatch(/<BringCryptoChecklist\s*\/>/);
  });
});
