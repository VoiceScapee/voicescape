/**
 * PageVoiceMic render test (video-fix: docked in-flow, no float).
 *
 * The mic used to float fixed bottom-left and covered whatever text
 * scrolled under it at idle on a 375px phone; the L5 scroll-fade only hid
 * it while scrolling. It now docks in the page flow after the blocks, so
 * it occupies its own layout space and can never cover tappable text.
 * Dragging is gone with the float. What this file pins down (renderToString
 * — the repo's vitest is node-only, no jsdom): the dock renders in-flow
 * with no fixed positioning, no scroll-fade, no drag affordance. The live
 * 375px overlap check (mic rect vs every link rect, top/middle/bottom)
 * runs in a real browser against the built page — see the report.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
}));

import { renderToString } from "react-dom/server";
import { LanguageProvider } from "@/lib/i18n/LanguageContext";
import PageVoiceMic from "@/components/PageVoiceMic";

describe("PageVoiceMic (video-fix dock)", () => {
  it("renders the mic in-flow — no fixed positioning, no scroll-fade, no drag", () => {
    const html = renderToString(
      <LanguageProvider>
        <PageVoiceMic username="voicescape-webseries" page={null} />
      </LanguageProvider>,
    );
    expect(html).toContain("pv-mic-dock");
    expect(html).toContain("pv-mic-btn");
    expect(html).toContain("Talk to this page");
    // Nothing in the markup may pin the mic to the viewport.
    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("position: fixed");
    // The L5 scroll-fade is gone with the float — nothing to fade.
    expect(html).not.toContain("transition:opacity 200ms ease");
    expect(html).not.toContain("drag to move");
    // Panel closed by default — it opens below the button when tapped.
    expect(html).not.toContain("pv-mic-panel");
  });
});
