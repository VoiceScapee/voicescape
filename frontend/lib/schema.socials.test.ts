/**
 * Schema tests for the socials block:
 * normalizeBlockForRender, createDefaultBlock, and isValidPage.
 */
import { describe, expect, it } from "vitest";
import { createDefaultBlock, isValidPage, normalizeBlockForRender } from "./schema";

describe("socials block", () => {
  it("creates an empty default block", () => {
    expect(createDefaultBlock("socials")).toEqual({ type: "socials", items: [] });
  });

  it("normalizes valid items", () => {
    expect(
      normalizeBlockForRender({
        type: "socials",
        items: [
          { platform: "x", url: "https://x.com/u" },
          { platform: "instagram", url: "https://instagram.com/u" },
        ],
      }),
    ).toEqual({
      type: "socials",
      items: [
        { platform: "x", url: "https://x.com/u" },
        { platform: "instagram", url: "https://instagram.com/u" },
      ],
    });
  });

  it("falls back unknown platforms to website and drops empty URLs", () => {
    expect(
      normalizeBlockForRender({
        type: "socials",
        items: [
          { platform: "myspace", url: "https://myspace.com/u" },
          { platform: "x", url: "" },
          { platform: "x", url: "https://x.com/u" },
          // Non-string platform falls back to website; the URL still counts.
          { platform: 5, url: "https://example.com/u" },
        ],
      }),
    ).toEqual({
      type: "socials",
      items: [
        { platform: "website", url: "https://myspace.com/u" },
        { platform: "x", url: "https://x.com/u" },
        { platform: "website", url: "https://example.com/u" },
      ],
    });
  });

  it("drops malformed entries and never crashes on junk", () => {
    expect(
      normalizeBlockForRender({
        type: "socials",
        items: [
          { platform: "x", url: "https://x.com/u" },
          null,
          "https://x.com/u",
          42,
          { platform: "x" },
          { platform: "x", url: null },
        ],
      }),
    ).toEqual({
      type: "socials",
      items: [{ platform: "x", url: "https://x.com/u" }],
    });
    expect(normalizeBlockForRender({ type: "socials" })).toEqual({
      type: "socials",
      items: [],
    });
    expect(normalizeBlockForRender({ type: "socials", items: "nope" })).toEqual({
      type: "socials",
      items: [],
    });
  });

  it("caps items at 12", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      platform: "x",
      url: `https://x.com/u${i}`,
    }));
    const out = normalizeBlockForRender({ type: "socials", items });
    expect(out).not.toBeNull();
    expect(out!.type).toBe("socials");
    if (out !== null && out.type === "socials") expect(out.items).toHaveLength(12);
  });
});

describe("isValidPage with socials", () => {
  const base = {
    version: 1,
    username: "test",
    theme: {
      background: "#000",
      foreground: "#fff",
      accent: "#0ff",
      fontFamily: "sans",
    },
  };

  it("accepts a page with a valid socials block", () => {
    expect(
      isValidPage({
        ...base,
        blocks: [
          { type: "socials", items: [{ platform: "x", url: "https://x.com/u" }] },
        ],
      }),
    ).toBe(true);
  });

  it("rejects malformed socials items", () => {
    expect(
      isValidPage({
        ...base,
        blocks: [{ type: "socials", items: [{ platform: "x", url: 42 }] }],
      }),
    ).toBe(false);
  });

  it("still accepts older pages without socials", () => {
    expect(
      isValidPage({
        ...base,
        blocks: [{ type: "links", items: [{ label: "A", url: "https://a.com" }] }],
      }),
    ).toBe(true);
  });
});
