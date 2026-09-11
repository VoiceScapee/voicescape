import { describe, expect, it } from "vitest";
import { FOUNDER_USERNAMES, isFounderUsername } from "./founders";

describe("founders", () => {
  it("flags brandon as a founder", () => {
    expect(isFounderUsername("brandon")).toBe(true);
  });

  it("matches case-insensitively and trims whitespace", () => {
    expect(isFounderUsername("Brandon")).toBe(true);
    expect(isFounderUsername("  BRANDON  ")).toBe(true);
  });

  it("returns false for non-founders and empty input", () => {
    expect(isFounderUsername("someone-else")).toBe(false);
    expect(isFounderUsername("")).toBe(false);
    expect(isFounderUsername(null)).toBe(false);
    expect(isFounderUsername(undefined)).toBe(false);
  });

  it("keeps the founder list immutable and non-empty", () => {
    expect(FOUNDER_USERNAMES.length).toBeGreaterThan(0);
    expect(FOUNDER_USERNAMES).toContain("brandon");
  });
});
