import { describe, expect, it } from "vitest";
import { ACTIVE_SEASON, seasonForPath, seasonPageForPath } from "./season";

describe("season", () => {
  it("has an active season set", () => {
    expect(ACTIVE_SEASON).toBe("october");
  });

  it("maps shell routes to their seasonal page motifs", () => {
    expect(seasonPageForPath("/")).toBe("home");
    expect(seasonPageForPath("/explore")).toBe("discover");
    expect(seasonPageForPath("/townhall")).toBe("townhall");
    expect(seasonPageForPath("/marketplace")).toBe("marketplace");
    expect(seasonPageForPath("/builder")).toBe("voice");
    expect(seasonPageForPath("/agents")).toBe("agents");
    expect(seasonPageForPath("/agents/start")).toBe("agents");
    // The Amazon demo page is NEVER re-skinned (Brandon 2026-10-10).
    expect(seasonPageForPath("/alexa-demo")).toBe("sovereign");
    expect(seasonPageForPath("/console")).toBe("default");
    expect(seasonPageForPath("/mcp")).toBe("default");
  });

  it("treats blockpages and user-owned link routes as sovereign", () => {
    expect(seasonPageForPath("/user-10425063")).toBe("sovereign");
    expect(seasonPageForPath("/thechomps")).toBe("sovereign");
    expect(seasonPageForPath("/p/abc123")).toBe("sovereign");
    expect(seasonPageForPath("/t/xyz")).toBe("sovereign");
    expect(seasonPageForPath("/c/claim-1")).toBe("sovereign");
    expect(seasonPageForPath("/v/vid-9")).toBe("sovereign");
    expect(seasonPageForPath("/embed/user-10425063")).toBe("sovereign");
  });

  it("ignores query strings and hashes", () => {
    expect(seasonPageForPath("/?season=winter")).toBe("home");
    expect(seasonPageForPath("/thechomps#music")).toBe("sovereign");
  });

  it("handles empty input safely", () => {
    expect(seasonPageForPath("")).toBe("home");
  });

  it("gates the seasonal skin by the line-by-line rollout list", () => {
    // 2026-10-10 night: Brandon said "wire the rest of it up except demo
    // page" — the full shell wears October. Sovereign (demo page +
    // user blockpages) still keeps the default theme, forever.
    expect(seasonForPath("/")).toBe(ACTIVE_SEASON);
    expect(seasonForPath("/explore")).toBe(ACTIVE_SEASON);
    expect(seasonForPath("/townhall")).toBe(ACTIVE_SEASON);
    expect(seasonForPath("/marketplace")).toBe(ACTIVE_SEASON);
    expect(seasonForPath("/builder")).toBe(ACTIVE_SEASON);
    expect(seasonForPath("/agents")).toBe(ACTIVE_SEASON);
    expect(seasonForPath("/console")).toBe(ACTIVE_SEASON);
    expect(seasonForPath("/thechomps")).toBe("none");
    expect(seasonForPath("/alexa-demo")).toBe("none");
  });
});
