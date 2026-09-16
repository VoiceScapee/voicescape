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
