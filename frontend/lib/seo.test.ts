import { describe, expect, it } from "vitest";
import {
  buildBreadcrumbJsonLd,
  buildPageMetadata,
  jsonLdHtml,
  siteUrl,
  truncate,
} from "./seo";

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
      "https://voicescape.vercel.app/voicescape-logo.webp",
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

  it("emits a per-page canonical and matching og:url, never the homepage", () => {
    const meta = buildPageMetadata({
      title: "Agent Intros — Voicescape",
      description: "d",
      url: "/intros",
    });
    const alternates = meta.alternates as Record<string, unknown>;
    expect(alternates.canonical).toBe("https://voicescape.vercel.app/intros");
    const og = meta.openGraph as Record<string, unknown>;
    expect(og.url).toBe("https://voicescape.vercel.app/intros");
  });
});

describe("jsonLdHtml", () => {
  it("serializes to JSON and escapes < so </script> cannot break out", () => {
    const out = jsonLdHtml({
      "@type": "CreativeWork",
      text: 'a </script><script>alert("x")</script> b',
    });
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c/script>");
    expect(JSON.parse(out.replace(/\\u003c/g, "<"))).toEqual({
      "@type": "CreativeWork",
      text: 'a </script><script>alert("x")</script> b',
    });
  });
});

describe("buildBreadcrumbJsonLd", () => {
  it("emits 1-based ListItems with absolute URLs", () => {
    const doc = buildBreadcrumbJsonLd([
      { name: "Home", url: "/" },
      { name: "Explore Blockpages", url: "/explore" },
    ]);
    expect(doc).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: "https://voicescape.vercel.app/",
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Explore Blockpages",
          item: "https://voicescape.vercel.app/explore",
        },
      ],
    });
  });

  it("passes absolute URLs through unchanged", () => {
    const doc = buildBreadcrumbJsonLd([
      { name: "Elsewhere", url: "https://example.com/page" },
    ]);
    const items = doc.itemListElement as { item: string }[];
    expect(items[0].item).toBe("https://example.com/page");
  });
});
