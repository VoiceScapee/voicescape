/**
 * BuddyDraftPreview tests: the inline in-chat draft preview renders the
 * draft through PageRenderer in preview mode, stays non-interactive, and
 * never crashes on a minimal draft.
 *
 * Repo convention for components is source assertions (no DOM in this
 * suite). The "does not crash" check calls the function component
 * directly — creating the element exercises the component body without
 * needing a renderer.
 *
 * ROUND 4 regression (2026-09-16): the Buddy widget mounts OUTSIDE
 * RootProviders, so this tree has no SessionProvider and no
 * LanguageProvider. Live, a mock containing a chat block (ChatBox calls
 * useSession()) or a tipJar block (TipJarCard calls useLanguage()) threw
 * here — the error boundary swallowed the whole visual mock and showed
 * "That preview didn't load cleanly". The renderToString tests below
 * exercise the TRUE live condition: no providers at all.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderToString } from "react-dom/server";
import BuddyDraftPreview from "./BuddyDraftPreview";
import { isValidPage, templatePreviewPage } from "@/lib/schema";
import type { VoicescapePage } from "@/lib/schema";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "BuddyDraftPreview.tsx"), "utf8");

const minimalDraft: VoicescapePage = {
  version: 1,
  username: "test-page",
  theme: {
    background: "#000000",
    foreground: "#ffffff",
    accent: "#8259ef",
    fontFamily: "sans-serif",
  },
  blocks: [],
};

describe("BuddyDraftPreview", () => {
  it("is a client component with no new dependencies", () => {
    expect(src).toContain('"use client"');
    expect(src).toContain('from "./PageRenderer"');
  });

  it("does not crash on a minimal draft", () => {
    let el: unknown;
    expect(() => {
      el = BuddyDraftPreview({ page: minimalDraft });
    }).not.toThrow();
    const props = (el as { props: { "aria-label"?: string } }).props;
    expect(props["aria-label"]).toContain("test-page");
  });

  it("renders the draft through PageRenderer in preview mode", () => {
    expect(src).toContain("<PageRenderer");
    expect(src).toContain("page={page}");
    expect(src).toContain("preview");
  });

  it("is non-interactive and clearly labeled", () => {
    // pointer-events off: taps/links/tips inside can't fire from the chat.
    expect(src).toContain('pointerEvents: "none"');
    expect(src).toContain("Your page preview");
  });

  it("renders the deterministic template with NO providers (live widget condition)", () => {
    // The widget mounts outside RootProviders — this is the exact live
    // condition that crashed on 2026-09-16. Must not throw, must emit
    // real visual markup (not the error-boundary fallback).
    const page = templatePreviewPage(
      "e2epreview03",
      "End-to-end test page, please ignore.",
      "minimal dark"
    );
    expect(isValidPage(page)).toBe(true);
    let html = "";
    expect(() => {
      html = renderToString(<BuddyDraftPreview page={page} />);
    }).not.toThrow();
    expect(html).toContain("buddy-draft-preview");
    expect(html).toContain("E2epreview03");
    expect(html).not.toContain("preview-error-fallback");
    expect(html.length).toBeGreaterThan(500);
  });

  it("renders chat + livestream + tipJar blocks with NO providers (the live crash)", () => {
    // The live mock carried a chat block: ChatBox called useSession()
    // with no SessionProvider above and the whole mock vanished behind
    // the boundary fallback. Livestream blocks embed ChatBox too, and
    // tipJar blocks need useLanguage(). All must render inertly here.
    const page: VoicescapePage = {
      version: 1,
      username: "chatty",
      theme: {
        background: "#1e1e1e",
        foreground: "#f5f5f5",
        accent: "#ffcc00",
        fontFamily: "system-ui, sans-serif",
      },
      blocks: [
        { type: "hero", title: "Chatty", avatarEmoji: "💬" },
        { type: "bio", text: "I love chatting" },
        { type: "chat", title: "Community chat" },
        { type: "livestream", platform: "twitch", channel: "somechannel" },
        { type: "tipJar", message: "Thanks!" },
      ],
    };
    expect(isValidPage(page)).toBe(true);
    let html = "";
    expect(() => {
      html = renderToString(<BuddyDraftPreview page={page} />);
    }).not.toThrow();
    expect(html).toContain("Chatty");
    expect(html).not.toContain("preview-error-fallback");
  });
});
