import { describe, expect, it } from "vitest";
import { MINING_DEPIN_PROJECTS } from "./mining-depin";

/**
 * Guards for the curated Mining & DePIN showcase. Every listing is a real
 * outbound link a visitor can tap — no placeholders, no dead entries, and
 * the "verified" promise stays honest (dates present and well-formed).
 */
describe("mining-depin showcase data", () => {
  it("has both mining and depin entries", () => {
    const cats = new Set(MINING_DEPIN_PROJECTS.map((p) => p.category));
    expect(cats.has("mining")).toBe(true);
    expect(cats.has("depin")).toBe(true);
  });

  it("every project has a real https URL and non-empty copy", () => {
    for (const p of MINING_DEPIN_PROJECTS) {
      expect(p.url, `${p.id} url`).toMatch(/^https:\/\//);
      expect(p.name.trim().length, `${p.id} name`).toBeGreaterThan(0);
      expect(p.tagline.trim().length, `${p.id} tagline`).toBeGreaterThan(0);
      expect(p.description.trim().length, `${p.id} description`).toBeGreaterThan(0);
      expect(p.whyTrusted.trim().length, `${p.id} whyTrusted`).toBeGreaterThan(0);
    }
  });

  it("ids are unique", () => {
    const ids = MINING_DEPIN_PROJECTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every project carries a well-formed verification date", () => {
    for (const p of MINING_DEPIN_PROJECTS) {
      expect(p.verifiedAt, `${p.id} verifiedAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("project links go straight to the official site (no referral layer)", () => {
    // Brandon 2026-09-15: referral links are out — every card links the
    // project's official URL directly.
    for (const p of MINING_DEPIN_PROJECTS) {
      expect(p.url, `${p.id} url`).toMatch(/^https:\/\//);
      expect("referralUrl" in p, `${p.id} has no referralUrl`).toBe(false);
    }
  });
});
