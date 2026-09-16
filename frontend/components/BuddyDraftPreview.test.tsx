/**
 * BuddyDraftPreview tests: the inline in-chat draft preview renders the
 * draft through PageRenderer in preview mode, stays non-interactive, and
 * never crashes on a minimal draft.
 *
 * Repo convention for components is source assertions (no DOM in this
 * suite). The "does not crash" check calls the function component
 * directly — creating the element exercises the component body without
 * needing a renderer.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import BuddyDraftPreview from "./BuddyDraftPreview";
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
});
