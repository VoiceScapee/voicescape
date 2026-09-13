import { describe, expect, it } from "vitest";
import { FOUNDER_USERNAMES, isFounderUsername, resolveFounderBadge } from "./founders";

describe("founders", () => {
  it("flags the registered founder blockpage", () => {
    expect(isFounderUsername("user-10424063")).toBe(true);
  });

  it("does NOT flag the stale 0xcreator handle (never registered on-chain)", () => {
    expect(isFounderUsername("0xcreator")).toBe(false);
    expect(FOUNDER_USERNAMES).not.toContain("0xcreator");
  });

  it("matches case-insensitively and trims whitespace", () => {
    expect(isFounderUsername("User-10424063")).toBe(true);
    expect(isFounderUsername("  USER-10424063  ")).toBe(true);
  });

  it("returns false for non-founders and empty input", () => {
    expect(isFounderUsername("someone-else")).toBe(false);
    expect(isFounderUsername("")).toBe(false);
    expect(isFounderUsername(null)).toBe(false);
    expect(isFounderUsername(undefined)).toBe(false);
  });

  it("keeps the founder list immutable and non-empty", () => {
    expect(FOUNDER_USERNAMES.length).toBeGreaterThan(0);
    expect(FOUNDER_USERNAMES).toContain("user-10424063");
  });
});

describe("resolveFounderBadge — spoof-resistant gating", () => {
  it("badges the founder's canonical route identity", () => {
    expect(resolveFounderBadge("user-10424063", "user-10424063")).toBe(true);
  });

  it("ignores a spoofed IPFS username on a non-founder route", () => {
    // Attack: pin {"username": "user-10424063"} and serve it from your own
    // route. The badge must NOT appear — the route identity rules.
    expect(resolveFounderBadge("attacker-page", "user-10424063")).toBe(false);
  });

  it("does not badge when neither identity is a founder", () => {
    expect(resolveFounderBadge("someone-else", "someone-else")).toBe(false);
    expect(resolveFounderBadge(null, null)).toBe(false);
  });

  it("falls back to the page username only when no canonical identity exists (builder preview)", () => {
    expect(resolveFounderBadge(null, "user-10424063")).toBe(true);
    expect(resolveFounderBadge(undefined, "someone-else")).toBe(false);
  });
});
