import { describe, expect, it } from "vitest";
import {
  PLATFORMS,
  PLATFORM_IDS,
  detectPlatform,
  isPlatformId,
  normalizeSocialUrl,
} from "./socials";

describe("detectPlatform", () => {
  it.each([
    ["https://x.com/someone", "x"],
    ["https://twitter.com/someone", "x"],
    ["https://mobile.twitter.com/someone", "x"],
    ["https://www.x.com/someone", "x"],
    ["https://instagram.com/someone", "instagram"],
    ["https://www.instagram.com/someone", "instagram"],
    ["https://tiktok.com/@someone", "tiktok"],
    ["https://www.tiktok.com/@someone/video/123", "tiktok"],
    ["https://youtube.com/@someone", "youtube"],
    ["https://www.youtube.com/watch?v=abc", "youtube"],
    ["https://youtu.be/abc123", "youtube"],
    ["https://twitch.tv/someone", "twitch"],
    ["https://www.twitch.tv/someone", "twitch"],
    ["https://facebook.com/someone", "facebook"],
    ["https://fb.com/someone", "facebook"],
    ["https://discord.gg/invite", "discord"],
    ["https://discord.com/invite/abc", "discord"],
    ["https://linkedin.com/in/someone", "linkedin"],
    ["https://www.linkedin.com/in/someone", "linkedin"],
    ["https://github.com/someone", "github"],
    // Schemeless domain/path still detects.
    ["x.com/someone", "x"],
    ["instagram.com/someone", "instagram"],
    ["tiktok.com/@someone", "tiktok"],
  ])("detects %s as %s", (url, expected) => {
    expect(detectPlatform(url)).toBe(expected);
  });

  it("falls back to website for unknown or unparseable input", () => {
    expect(detectPlatform("https://example.com/someone")).toBe("website");
    // "notx.com" merely ends with "x.com" — must not false-positive.
    expect(detectPlatform("https://notx.com/someone")).toBe("website");
    expect(detectPlatform("https://fakeyoutube.com/@x")).toBe("website");
    expect(detectPlatform("@someone")).toBe("website");
    expect(detectPlatform("someone")).toBe("website");
    expect(detectPlatform("")).toBe("website");
    expect(detectPlatform("   ")).toBe("website");
    expect(detectPlatform("not a url at all")).toBe("website");
  });
});

describe("normalizeSocialUrl", () => {
  it("passes full URLs through (trimmed)", () => {
    expect(normalizeSocialUrl("https://x.com/someone")).toBe("https://x.com/someone");
    expect(normalizeSocialUrl("  https://x.com/someone  ")).toBe("https://x.com/someone");
    expect(normalizeSocialUrl("http://example.com/page")).toBe("http://example.com/page");
  });

  it("adds https:// to schemeless domain/path input", () => {
    expect(normalizeSocialUrl("x.com/someone")).toBe("https://x.com/someone");
    expect(normalizeSocialUrl("www.instagram.com/someone")).toBe(
      "https://www.instagram.com/someone"
    );
    expect(normalizeSocialUrl("tiktok.com/@someone")).toBe("https://tiktok.com/@someone");
  });

  it("returns null for bare handles and junk", () => {
    expect(normalizeSocialUrl("@someone")).toBeNull();
    expect(normalizeSocialUrl("someone")).toBeNull();
    expect(normalizeSocialUrl("")).toBeNull();
    expect(normalizeSocialUrl("   ")).toBeNull();
    // Whitespace inside a URL is never valid.
    expect(normalizeSocialUrl("https://x.com/a b")).toBeNull();
    expect(normalizeSocialUrl("x.com/a b")).toBeNull();
  });
});

describe("isPlatformId", () => {
  it("accepts every known platform id", () => {
    for (const id of PLATFORM_IDS) expect(isPlatformId(id)).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isPlatformId("myspace")).toBe(false);
    expect(isPlatformId("")).toBe(false);
    expect(isPlatformId(null)).toBe(false);
    expect(isPlatformId(undefined)).toBe(false);
    expect(isPlatformId(42)).toBe(false);
  });
});

describe("PLATFORMS", () => {
  it("has a non-empty display name for every platform id", () => {
    for (const id of PLATFORM_IDS) {
      expect(PLATFORMS[id].id).toBe(id);
      expect(PLATFORMS[id].name.length).toBeGreaterThan(0);
    }
  });
});
