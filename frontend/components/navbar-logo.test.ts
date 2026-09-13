/**
 * Navbar logo sizing regression tests (source assertions, repo convention).
 *
 * Brandon's call 2026-09-13: the navbar logo left empty space in its row —
 * it should stretch to fit all the way across the available width.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const navSrc = readFileSync(join(here, "Navbar.tsx"), "utf8");
const logoSrc = readFileSync(join(here, "Logo.tsx"), "utf8");

describe("navbar logo sizing", () => {
  it("there is no banner bar behind the logo", () => {
    // Brandon 2026-09-13: no dark bar — just the logo floating over the page.
    expect(navSrc).not.toMatch(/background:\s*"rgba\(9,11,18/);
    expect(navSrc).not.toMatch(/backdropFilter/);
    expect(navSrc).not.toMatch(/borderBottom/);
  });

  it("the navbar renders the logo in fluid mode", () => {
    expect(navSrc).toMatch(/<Logo[^>]*\bfluid\b/);
  });

  it("the logo link is allowed to grow across the row", () => {
    expect(navSrc).toMatch(/flex:\s*"1 1 200px"/);
    expect(navSrc).toMatch(/maxWidth:\s*320/);
  });

  it("fluid mode fills width and keeps the 3:1 lockup aspect", () => {
    expect(logoSrc).toMatch(/width:\s*"100%"/);
    expect(logoSrc).toMatch(/height:\s*"auto"/);
  });

  it("fixed-size mode still works for other call sites", () => {
    expect(logoSrc).toMatch(/height:\s*size/);
    expect(logoSrc).toMatch(/width:\s*"auto"/);
  });
});
