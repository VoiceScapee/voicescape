import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The marketplace route exists at /marketplace (town-hall group) but users
 * could not reach it: it was missing from the navbar. This locks the link
 * into the Community nav group (rendered as a dropdown on desktop and a
 * flat section in the mobile menu).
 */
describe("Navbar — marketplace link", () => {
  const src = readFileSync(new URL("./Navbar.tsx", import.meta.url), "utf8");

  it("includes /marketplace in the Community nav items", () => {
    expect(src).toContain('href: "/marketplace"');
  });

  it("keeps the marketplace label next to the other community destinations", () => {
    const community = src.slice(
      src.indexOf("COMMUNITY_ITEMS"),
      src.indexOf("SUPPORT_HREF"),
    );
    expect(community).toContain("/marketplace");
    expect(community).toContain("/forum");
    expect(community).toContain("/explore");
  });
});

describe("Navbar — legal links", () => {
  const src = readFileSync(new URL("./Navbar.tsx", import.meta.url), "utf8");

  it("exposes /terms and /privacy in the Learn nav group", () => {
    const learn = src.slice(
      src.indexOf("LEARN_ITEMS"),
      src.indexOf("COMMUNITY_ITEMS"),
    );
    expect(learn).toContain('href: "/terms"');
    expect(learn).toContain('href: "/privacy"');
  });
});

describe("Navbar — mobile menu (Brandon 2026-10-01 cleanup)", () => {
  const src = readFileSync(new URL("./Navbar.tsx", import.meta.url), "utf8");

  it("renders the three nav groups as accordions, not a flat 17-row list", () => {
    expect(src).toContain("MobileNavGroup");
    expect(src).toContain('id="create"');
    expect(src).toContain('id="learn"');
    expect(src).toContain('id="community"');
    // The old flat labelled sections are gone.
    expect(src).not.toContain("vs-nav-group-label");
  });

  it("gives the header a solid background while the mobile menu is open", () => {
    expect(src).toContain("vs-nav-menu-open");
  });

  it("keeps support/install/language/wallet on the desktop row", () => {
    expect(src).toContain("vs-nav-desktop-tools");
    expect(src).toContain("SUPPORT_HREF");
  });

  it("separates wallet controls into a mobile menu footer", () => {
    expect(src).toContain("vs-nav-mobile-footer");
    expect(src).toContain("vs-nav-mobile-account");
  });
});
