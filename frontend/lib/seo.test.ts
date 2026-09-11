import { describe, expect, it } from "vitest";
import { buildPageMetadata, siteUrl, truncate } from "./seo";

describe("siteUrl", () => {
  it("falls back to the production domain when no env is set", () => {
    expect(siteUrl()).toBe("https://voicescape.vercel.app");
  });

  it("strips trailing slashes", () => {
    process.env.APP_ORIGIN = "https://example.com///";
    expect(siteUrl()).toBe("https://example.com");
    delete process.env.APP_ORIGIN;
  });
});

describe("truncate", () => {
  it("returns short text unchanged", () => {
    expect(truncate("hello", 200)).toBe("hello");
  });

  it("caps at max chars with an ellipsis", () => {
    const out = truncate("a".repeat(300), 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
  });

  it("collapses whitespace", () => {
    expect(truncate("a\n\n  b", 200)).toBe("a b");
  });
});

describe("buildPageMetadata", () => {
  it("emits Open Graph + Twitter Card tags with absolute URLs", () => {
    const meta = buildPageMetadata({
      title: "alice on Voicescape",
      description: "Alice's page",
      url: "/alice",
      type: "profile",
    });
    expect(meta.title).toBe("alice on Voicescape");
    const og = meta.openGraph as Record<string, unknown>;
    expect(og.type).toBe("profile");
    expect(og.siteName).toBe("Voicescape");
    expect(og.url).toBe("https://voicescape.vercel.app/alice");
    const images = og.images as { url: string }[];
    expect(images[0].url).toBe(
      "https://voicescape.vercel.app/voicescape-banner.jpg",
    );
    const tw = meta.twitter as Record<string, unknown>;
    expect(tw.card).toBe("summary_large_image");
    expect(tw.title).toBe("alice on Voicescape");
  });

  it("uses a custom absolute image when provided", () => {
    const meta = buildPageMetadata({
      title: "t",
      description: "d",
      url: "/x",
      image: "https://cdn.example.com/pic.png",
    });
    const og = meta.openGraph as Record<string, unknown>;
    const images = og.images as { url: string }[];
    expect(images[0].url).toBe("https://cdn.example.com/pic.png");
  });
});
