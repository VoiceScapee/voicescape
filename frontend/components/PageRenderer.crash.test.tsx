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
import { applyPreviewTweak, isValidPage, normalizeBlockForRender, templatePreviewPage, type VoicescapePage } from "@/lib/schema";

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

describe("PageRenderer wrong-typed scalars — live crash 2026-09-16", () => {
  // The model emitted schema-valid mocks whose SCALAR fields were objects
  // (e.g. hero title: {text: ...}) — isValidPage doesn't check those, and
  // the old normalizer only fixed arrays. (block.title || "?").trim()
  // threw "trim is not a function" and {block.title} threw "Objects are not
  // valid as a React child" — unmounting the whole app. The deep sanitizer
  // must coerce every renderer-touched scalar to a string.
  const adversarialBlocks: Array<[string, unknown]> = [
    ["hero title is an object", { type: "hero", title: { text: "Hi" } }],
    ["hero title is a number", { type: "hero", title: 42 }],
    ["hero subtitle/avatarEmoji are objects", { type: "hero", title: "Hi", subtitle: { t: 1 }, avatarEmoji: ["x"] }],
    ["bio text is an object", { type: "bio", text: { rich: true } }],
    ["links label is an object", { type: "links", items: [{ label: { t: "x" }, url: "https://x.com/a" }] }],
    ["links url is an object", { type: "links", items: [{ label: "x", url: { u: 1 } }] }],
    ["top8 friend name is an object", { type: "top8", friends: [{ name: { first: "H" } }] }],
    ["top8 friend avatarEmoji is an object", { type: "top8", friends: [{ name: "H", avatarEmoji: { e: 1 } }] }],
    ["guestbook entry fields are objects", { type: "guestbook", entries: [{ name: { n: 1 }, message: { m: 2 }, date: { d: 3 } }] }],
    ["reviews title is an object", { type: "reviews", title: { t: 1 }, entries: [] }],
    ["music track title/artist are objects", { type: "music", tracks: [{ source: "youtube", id: "abc", title: { t: 1 }, artist: [1] }] }],
    ["music track source/id are objects (track dropped)", { type: "music", tracks: [{ source: { s: 1 }, id: { i: 2 } }] }],
    ["services item fields are objects", { type: "services", items: [{ name: { n: 1 }, description: { d: 1 }, priceUsdCents: "free", endpoint: { e: 1 } }] }],
    ["booking item note is an object", { type: "booking", items: [{ label: "x", url: "https://x.com", note: { n: 1 } }] }],
    ["livestream channel is an object", { type: "livestream", platform: "youtube", channel: { c: 1 } }],
    ["tipJar message is an object", { type: "tipJar", message: { m: 1 } }],
    ["operator wallet/name are objects", { type: "operator", wallet: { w: 1 }, name: { n: 1 } }],
    ["gallery effect is an object", { type: "gallery", images: ["🎨"], effect: { e: 1 } }],
  ];

  for (const [name, block] of adversarialBlocks) {
    it(`renders without throwing: ${name}`, () => {
      const normalized = normalizeBlockForRender(block);
      expect(normalized).not.toBeNull();
      const page: VoicescapePage = {
        version: 1,
        username: "advtest",
        theme,
        blocks: [normalized as VoicescapePage["blocks"][number]],
      };
      let html = "";
      expect(() => {
        html = renderToString(
          <LanguageProvider>
            <PageRenderer page={page} preview />
          </LanguageProvider>
        );
      }).not.toThrow();
      expect(html).toContain("advtest");
    });
  }

  it("coerces wrong-typed scalars to safe strings", () => {
    const hero = normalizeBlockForRender({ type: "hero", title: { text: "Hi" }, subtitle: 42 }) as { title: unknown; subtitle: unknown };
    expect(hero.title).toBe("?");
    expect(hero.subtitle).toBeUndefined();
    const links = normalizeBlockForRender({ type: "links", items: [{ label: { t: 1 }, url: 7 }] }) as { items: Array<{ label: unknown; url: unknown }> };
    expect(links.items[0]).toEqual({ label: "Link", url: "" });
    const svc = normalizeBlockForRender({ type: "services", items: [{ name: "x", priceUsdCents: "free" }] }) as { items: Array<{ priceUsdCents: unknown }> };
    expect(svc.items[0].priceUsdCents).toBe(0);
  });
});

describe("templatePreviewPage — deterministic mock fallback", () => {
  it("always produces a valid page that renders", () => {
    for (const [u, b, v] of [
      ["testpilotbuddy", "I make chiptune music", "neon arcade, dark purple and cyan"],
      ["", "", ""],
      ["UPPER", "bio", "minimal dark"],
    ] as Array<[string, string, string]>) {
      const page = templatePreviewPage(u, b, v);
      expect(isValidPage(page)).toBe(true);
      let html = "";
      expect(() => {
        html = renderToString(
          <LanguageProvider>
            <PageRenderer page={page} preview />
          </LanguageProvider>
        );
      }).not.toThrow();
      expect(html.length).toBeGreaterThan(100);
    }
  });

  it("grounds content in the collected slots and uses placeholder art only", () => {
    const page = templatePreviewPage("testpilotbuddy", "chiptune musician", "dark");
    expect(page.username).toBe("testpilotbuddy");
    expect(JSON.stringify(page.blocks)).toContain("chiptune musician");
    // No URLs that could burn image generation, no junk placeholders.
    expect(JSON.stringify(page)).not.toContain("ipfs");
    expect(JSON.stringify(page.blocks)).not.toContain("Item 1");
  });
});

describe("applyPreviewTweak — deterministic mock revision (mock #2)", () => {
  const base = () =>
    templatePreviewPage("testpilotbuddy", "chiptune musician", "neon arcade");

  function renders(page: VoicescapePage): string {
    // Full client path: validity gate + render, like the widget.
    expect(isValidPage(page)).toBe(true);
    return renderToString(
      <LanguageProvider>
        <PageRenderer page={page} preview />
      </LanguageProvider>
    );
  }

  it("'make it darker' applies the dark theme with a note", () => {
    const { page, note } = applyPreviewTweak(base(), "make it darker");
    expect(page.theme.background).toBe("#1e1e1e");
    expect(page.theme.foreground).toBe("#f5f5f5");
    expect(note).toContain("darker theme");
    expect(renders(page).length).toBeGreaterThan(100);
  });

  it("'lighter' applies the light theme", () => {
    const { page, note } = applyPreviewTweak(base(), "lighter please");
    expect(page.theme.background).toBe("#fafafa");
    expect(note).toContain("lighter theme");
    expect(renders(page).length).toBeGreaterThan(100);
  });

  it("color words set the accent", () => {
    const { page, note } = applyPreviewTweak(base(), "purple accents");
    expect(page.theme.accent).toBe("#a855f7");
    expect(note).toContain("purple");
    expect(renders(page).length).toBeGreaterThan(100);
  });

  it("emoji words swap the hero avatar", () => {
    const { page, note } = applyPreviewTweak(base(), "give me a rocket avatar");
    const hero = page.blocks.find((b) => b.type === "hero");
    expect(hero).toMatchObject({ type: "hero", avatarEmoji: "🚀" });
    expect(note).toContain("rocket");
    expect(renders(page).length).toBeGreaterThan(100);
  });

  it("'bigger hero' pumps up the hero", () => {
    const { page, note } = applyPreviewTweak(base(), "make the hero bigger");
    const hero = page.blocks.find((b) => b.type === "hero");
    expect(hero).toMatchObject({ type: "hero", avatarEmoji: "🚀" });
    expect(note).toContain("bolder hero");
    expect(renders(page).length).toBeGreaterThan(100);
  });

  it("unknown tweaks still produce a visibly different mock plus a guidance note", () => {
    const before = base();
    const { page, note } = applyPreviewTweak(before, "make it pop with pizzazz");
    expect(isValidPage(page)).toBe(true);
    // Visibly different from mock #1...
    expect(page.theme.accent).not.toBe(before.theme.accent);
    // ...and the note asks for specifics instead of failing silently.
    expect(note).toContain("fresh accent color");
    expect(renders(page).length).toBeGreaterThan(100);
  });

  it("an invalid base falls back to a fresh template, never a broken mock", () => {
    const { page } = applyPreviewTweak(
      { version: 1, username: 42, theme: {}, blocks: "nope" } as unknown as VoicescapePage,
      "darker"
    );
    expect(isValidPage(page)).toBe(true);
    expect(renders(page).length).toBeGreaterThan(100);
  });
});
