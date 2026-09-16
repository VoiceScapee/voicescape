/**
 * Buddy preview crash regression tests.
 *
 * Live failure (2026-09-16, 3/3 repros): the model emitted a schema-valid
 * mock whose blocks were missing the array fields PageRenderer maps over
 * (e.g. a music block without `tracks`). isValidPage only checks block
 * `type`, so the mock reached the client and PageRenderer threw
 * "Cannot read properties of undefined (reading 'map')" — unmounting the
 * whole app.
 *
 * The fix has two layers, both covered here:
 * 1. normalizeBlockForRender (lib/schema.ts) fills every missing array with
 *    [] and drops unknown block types.
 * 2. PageRenderer normalizes every block before rendering, and the
 *    /api/agent/chat preview path normalizes the mock before emitting
 *    build.preview.
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LanguageProvider } from "@/lib/i18n/LanguageContext";
import PageRenderer from "@/components/PageRenderer";
import { isValidPage, normalizeBlockForRender, type VoicescapePage } from "@/lib/schema";

const theme = { background: "#000", foreground: "#fff", accent: "#f0f", fontFamily: "sans" };

/** A page whose array-bearing blocks are ALL missing their array fields. */
function malformedPage(): VoicescapePage {
  return {
    version: 1,
    username: "crashtest",
    theme,
    blocks: [
      { type: "hero", title: "Hi" },
      { type: "bio", text: "bio" },
      { type: "links" },
      { type: "guestbook" },
      // The exact reported crash: legacy music shape without tracks.
      { type: "music", title: "Now vibing to", note: "test" },
      { type: "music", tracks: null },
      { type: "gallery" },
      { type: "gallery", images: [null, 42, "https://example.com/a.png"] },
      { type: "top8" },
      { type: "services" },
      { type: "services", items: [null] },
      { type: "capabilities" },
      { type: "reviews" },
      { type: "booking" },
      { type: "tipJar" },
      // Unknown block types must be dropped, never crash.
      { type: "definitely-not-a-block" },
    ] as unknown as VoicescapePage["blocks"],
  };
}

describe("normalizeBlockForRender", () => {
  it("fills every missing block array with [] and drops unknown types", () => {
    const page = malformedPage();
    // Blocks with merely *missing* arrays pass isValidPage — that's the
    // hole that crashed the app (null arrays and unknown types are
    // already rejected by validation).
    const missingOnly = {
      ...page,
      blocks: page.blocks.filter(
        (b) => (b as { type: string }).type !== "definitely-not-a-block" && (b as { tracks?: unknown }).tracks !== null
      ),
    };
    expect(isValidPage(missingOnly)).toBe(true);
    const normalized = page.blocks
      .map(normalizeBlockForRender)
      .filter((b): b is NonNullable<typeof b> => b !== null);
    // Unknown type dropped.
    expect(normalized.length).toBe(page.blocks.length - 1);
    for (const b of normalized) {
      if (b.type === "links" || b.type === "services" || b.type === "booking")
        expect(Array.isArray(b.items)).toBe(true);
      if (b.type === "guestbook" || b.type === "reviews")
        expect(Array.isArray(b.entries)).toBe(true);
      if (b.type === "music") expect(Array.isArray(b.tracks)).toBe(true);
      if (b.type === "gallery") expect(Array.isArray(b.images)).toBe(true);
      if (b.type === "top8") expect(Array.isArray(b.friends)).toBe(true);
      if (b.type === "capabilities") expect(Array.isArray(b.items)).toBe(true);
    }
  });

  it("drops null elements inside arrays and keeps valid ones", () => {
    const b = normalizeBlockForRender({ type: "services", items: [null, { name: "x" }] });
    expect(b).toMatchObject({ type: "services", items: [{ name: "x" }] });
    const g = normalizeBlockForRender({ type: "gallery", images: [null, ":logo:"] });
    expect(g).toMatchObject({ type: "gallery", images: [":logo:"] });
  });

  it("returns null for non-objects and unknown types", () => {
    expect(normalizeBlockForRender(null)).toBeNull();
    expect(normalizeBlockForRender("nope")).toBeNull();
    expect(normalizeBlockForRender({ type: "wat" })).toBeNull();
    expect(normalizeBlockForRender({})).toBeNull();
  });

  it("leaves scalar-only blocks untouched", () => {
    const hero = { type: "hero", title: "Hi", subtitle: "yo" };
    expect(normalizeBlockForRender(hero)).toEqual(hero);
  });
});

describe("PageRenderer crash-proofing", () => {
  it("renders a page with every array field missing — no throw", () => {
    const html = renderToString(
      <LanguageProvider>
        <PageRenderer page={malformedPage()} preview />
      </LanguageProvider>
    );
    expect(html).toContain("crashtest");
  });

  it("renders a music block with no tracks as the legacy now-vibing card", () => {
    const html = renderToString(
      <LanguageProvider>
        <PageRenderer
          page={{
            version: 1,
            username: "musictest",
            theme,
            blocks: [{ type: "music", title: "Now vibing to", note: "test" }] as unknown as VoicescapePage["blocks"],
          }}
          preview
        />
      </LanguageProvider>
    );
    expect(html).toContain("Now vibing to");
  });
});
