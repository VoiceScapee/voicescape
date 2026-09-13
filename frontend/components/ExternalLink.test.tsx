/**
 * ExternalLink + goal deep-link regression tests (source assertions, repo
 * convention).
 *
 * Bug 2026-09-13: inside HashPack's in-app browser, new-tab opens are
 * silently swallowed — plain target="_blank" taps (landing SaucerSwap /
 * HashPack links) did nothing. ExternalLink must fall back to same-tab
 * navigation when window.open is blocked. Separately, the fundraiser
 * board's ?goal=1 deep link scrolled before the owner-only goal form had
 * rendered (session restores after page data), landing Brandon at the top
 * of his profile instead of the goal setter.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const linkSrc = readFileSync(join(here, "ExternalLink.tsx"), "utf8");
const pulseSrc = readFileSync(
  join(here, "landing", "CommunityPulse.tsx"),
  "utf8",
);
const walletSrc = readFileSync(join(here, "WalletConnect.tsx"), "utf8");
const pageSrc = readFileSync(join(here, "..", "app", "[username]", "page.tsx"), "utf8");

describe("ExternalLink", () => {
  it("renders a new-tab anchor with safe rel by default", () => {
    expect(linkSrc).toMatch(/target=\{"_blank"\}|target="_blank"/);
    expect(linkSrc).toContain("noopener noreferrer");
    expect(linkSrc).toMatch(/<a[\s\S]*href=\{href\}/);
  });

  it("tries window.open first, then falls back to same-tab navigation when blocked", () => {
    expect(linkSrc).toContain('window.open(href, "_blank"');
    // Blocked/swallowed open (returns null) must still navigate somewhere.
    expect(linkSrc).toMatch(/if\s*\(!opened\)/);
    expect(linkSrc).toContain("window.location.href = href");
  });

  it("leaves modifier/middle clicks to the browser (power-user behavior unchanged)", () => {
    expect(linkSrc).toMatch(/e\.metaKey\s*\|\|\s*e\.ctrlKey\s*\|\|\s*e\.shiftKey\s*\|\|\s*e\.altKey/);
    expect(linkSrc).toMatch(/e\.button !== 0/);
  });

  it("chains a caller-provided onClick and respects preventDefault", () => {
    expect(linkSrc).toContain("onClick?.(e)");
    expect(linkSrc).toMatch(/if\s*\(e\.defaultPrevented\)\s*return/);
  });
});

describe("landing + wallet picker use ExternalLink for external links", () => {
  it("CommunityPulse freebies/showcase/articles/clips no longer rely on bare target=_blank", () => {
    expect(pulseSrc).toContain("ExternalLink");
    expect(pulseSrc).not.toMatch(/target="_blank"/);
    expect(pulseSrc).not.toContain("from \"next/link\"");
  });

  it("wallet picker 'Get HashPack' link uses ExternalLink", () => {
    expect(walletSrc).toContain("ExternalLink");
    expect(walletSrc).toMatch(
      /<ExternalLink[\s\S]*href="https:\/\/www\.hashpack\.app"/,
    );
  });
});

describe("?goal=1 deep-link scroll", () => {
  it("waits for ownership to resolve before scrolling", () => {
    // The goal form only renders for the owner; the session can restore
    // after page data, so the effect must depend on isOwner.
    expect(pageSrc).toMatch(
      /\},\s*\[autoGoal,\s*state\.status,\s*isOwner\]\);/,
    );
  });

  it("retries until the goal form exists instead of firing once", () => {
    expect(pageSrc).toContain('getElementById("set-funding-goal")');
    expect(pageSrc).toMatch(/setTimeout\(tryScroll/);
    expect(pageSrc).toContain("scrollIntoView");
  });
});
