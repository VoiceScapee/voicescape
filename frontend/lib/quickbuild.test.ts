/**
 * Quick-build (2026-09-29) tests: the one-tap "design my page from my links"
 * instruction is built purely from page state, and the onboarding-socials
 * prefill merges correctly.
 */
import { describe, expect, it } from "vitest";
import type { VoicescapePage } from "./schema";
import {
  QUICKBUILD_MAX_URLS,
  applyOnboardSocials,
  buildDesignFromLinksInstruction,
  socialsUrls,
} from "./quickbuild";

const basePage = (blocks: VoicescapePage["blocks"], username = "Brandon"): VoicescapePage => ({
  version: 1,
  username,
  blocks,
  theme: { background: "#000", foreground: "#fff", accent: "#38bdf8", fontFamily: "system" },
});

describe("socialsUrls", () => {
  it("collects socials-block URLs in order, deduped", () => {
    const page = basePage([
      { type: "hero", title: "B" },
      {
        type: "socials",
        items: [
          { platform: "x", url: "https://x.com/b" },
          { platform: "github", url: "https://github.com/b" },
        ],
      },
      {
        type: "socials",
        items: [{ platform: "x", url: "https://x.com/b" }], // duplicate
      },
    ]);
    expect(socialsUrls(page)).toEqual(["https://x.com/b", "https://github.com/b"]);
  });

  it("returns [] when there is no socials block", () => {
    expect(socialsUrls(basePage([{ type: "hero", title: "B" }]))).toEqual([]);
  });

  it("caps at QUICKBUILD_MAX_URLS", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      platform: "website" as const,
      url: `https://example.com/${i}`,
    }));
    expect(socialsUrls(basePage([{ type: "socials", items }]))).toHaveLength(
      QUICKBUILD_MAX_URLS,
    );
  });
});

describe("buildDesignFromLinksInstruction", () => {
  it("builds the instruction from the page username and socials URLs", () => {
    const page = basePage(
      [
        {
          type: "socials",
          items: [
            { platform: "x", url: "https://x.com/Brandon" },
            { platform: "instagram", url: "https://instagram.com/Brandon" },
          ],
        },
      ],
      "Brandon",
    );
    const instruction = buildDesignFromLinksInstruction(page);
    expect(instruction).toContain("Design a complete, great-looking blockpage for 'Brandon'");
    expect(instruction).toContain("https://x.com/Brandon");
    expect(instruction).toContain("https://instagram.com/Brandon");
    expect(instruction).toContain("Keep my socials row");
  });

  it("falls back to a generic name and profiles when the page is empty", () => {
    const instruction = buildDesignFromLinksInstruction(basePage([], "   "));
    expect(instruction).toContain("for 'my blockpage'");
    expect(instruction).toContain("my social profiles");
  });
});

describe("applyOnboardSocials", () => {
  it("fills the first socials block, merging with template items", () => {
    const page = basePage([
      { type: "hero", title: "B" },
      {
        type: "socials",
        items: [{ platform: "github", url: "https://github.com/b" }],
      },
    ]);
    const next = applyOnboardSocials(page, [
      "https://x.com/b",
      "https://github.com/b", // duplicate of template item
    ]);
    const block = next.blocks.find((b) => b.type === "socials");
    expect(block?.type).toBe("socials");
    if (block?.type === "socials") {
      expect(block.items).toEqual([
        { platform: "github", url: "https://github.com/b" },
        { platform: "x", url: "https://x.com/b" },
      ]);
    }
  });

  it("inserts a socials block after the hero when the template has none", () => {
    const page = basePage([{ type: "hero", title: "B" }, { type: "bio", text: "hi" }]);
    const next = applyOnboardSocials(page, ["https://x.com/b"]);
    expect(next.blocks[1]).toEqual({
      type: "socials",
      items: [{ platform: "x", url: "https://x.com/b" }],
    });
  });

  it("returns the page unchanged when there are no pasted socials", () => {
    const page = basePage([{ type: "hero", title: "B" }]);
    expect(applyOnboardSocials(page, [])).toBe(page);
    expect(applyOnboardSocials(page, undefined)).toBe(page);
  });

  it("dedupes, drops non-strings, and caps at 12", () => {
    const page = basePage([{ type: "hero", title: "B" }]);
    const urls = Array.from({ length: 14 }, (_, i) => `https://example.com/${i}`);
    const next = applyOnboardSocials(page, [
      "https://x.com/b",
      "https://x.com/b",
      42,
      null,
      ...urls,
    ]);
    const block = next.blocks.find((b) => b.type === "socials");
    if (block?.type === "socials") {
      expect(block.items).toHaveLength(12);
      expect(block.items[0]).toEqual({ platform: "x", url: "https://x.com/b" });
    } else {
      throw new Error("expected a socials block");
    }
  });
});
