/**
 * Renderer trust details (M2 photo avatars, M5 copy rows + 98/2 split +
 * jump nav) — markup assertions via react-dom/server. No jsdom needed:
 * copy behavior is click-driven and covered by parseCopyLink unit tests.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PageRenderer from "@/components/PageRenderer";
import type { VoicescapePage } from "@/lib/schema";

function pageWith(blocks: VoicescapePage["blocks"]): VoicescapePage {
  return {
    version: 1,
    username: "tester",
    theme: { background: "#000000", foreground: "#ffffff", accent: "#22c55e", fontFamily: "Arial" },
    blocks,
  };
}

describe("PageRenderer trust details", () => {
  it("renders the hero photo when avatarUrl is a valid https URL", () => {
    const html = renderToStaticMarkup(
      <PageRenderer
        page={pageWith([
          { type: "hero", title: "T", avatarUrl: "https://example.com/me.png", avatarEmoji: "🌐" },
        ])}
      />,
    );
    expect(html).toContain('src="https://example.com/me.png"');
    expect(html).not.toContain("🌐");
  });

  it("falls back to emoji/initial when avatarUrl is unsafe", () => {
    const html = renderToStaticMarkup(
      <PageRenderer
        page={pageWith([
          { type: "hero", title: "Zed", avatarUrl: "javascript:alert(1)", avatarEmoji: "🦎" },
          { type: "top8", friends: [{ name: "Al", avatarUrl: "data:image/png;base64,AAA" }] },
        ])}
      />,
    );
    expect(html).not.toContain("javascript:alert");
    expect(html).not.toContain("data:image/png");
    expect(html).toContain("🦎");
    // Friend with no emoji falls back to initial.
    expect(html).toContain(">A<");
  });

  it("renders copy: link rows as copy buttons (not anchors)", () => {
    const html = renderToStaticMarkup(
      <PageRenderer
        page={pageWith([
          {
            type: "links",
            items: [
              { label: "Registry proof", url: "copy:0.0.10854058" },
              { label: "Site", url: "https://example.com" },
            ],
          },
        ])}
      />,
    );
    expect(html).toContain("Registry proof");
    expect(html).toContain("0.0.10854058");
    // Copy row is a <button>, the normal link stays an <a>.
    expect(html).toContain("<button");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('href="copy:');
  });

  it("renders the visible 98/2 split on the tip jar card", () => {
    const html = renderToStaticMarkup(
      <PageRenderer page={pageWith([{ type: "tipJar", message: "Tip me" }])} />,
    );
    expect(html).toContain("98%");
    expect(html).toContain("2%");
    expect(html).toContain("Enforced on-chain by the Tips contract");
  });

  it("renders the section jump-nav with stable anchors for long pages", () => {
    const html = renderToStaticMarkup(
      <PageRenderer
        page={pageWith([
          { type: "hero", title: "T" },
          { type: "links", items: [] },
          { type: "music", title: "Anthem", tracks: [] },
          { type: "tipJar" },
          { type: "guestbook", entries: [] },
        ])}
      />,
    );
    expect(html).toContain("pv-jumpnav");
    expect(html).toContain('href="#pv-section-1"');
    expect(html).toContain('id="pv-section-2"');
    expect(html).toContain("Anthem");
    expect(html).toContain("Support");
  });

  it("omits the jump-nav on short pages", () => {
    const html = renderToStaticMarkup(
      <PageRenderer
        page={pageWith([
          { type: "hero", title: "T" },
          { type: "tipJar" },
        ])}
      />,
    );
    expect(html).not.toContain("pv-jumpnav");
  });
});
