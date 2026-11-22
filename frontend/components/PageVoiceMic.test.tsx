/**
 * PageVoiceMic render test (L5 tip-jar explainer fix).
 *
 * The scroll-hide itself is a window scroll listener + 500ms timer in
 * useEffect — it cannot run under renderToString (the repo's vitest is
 * node-only, no jsdom), so the live behavior is verified on Brandon's
 * phone. What this file pins down: the button renders with the fade
 * transition and the idle-visible state, so a future edit can't
 * silently drop the fix.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
}));

import { renderToString } from "react-dom/server";
import { LanguageProvider } from "@/lib/i18n/LanguageContext";
import PageVoiceMic from "@/components/PageVoiceMic";

describe("PageVoiceMic (L5)", () => {
  it("renders the mic button with the scroll-fade transition, visible when idle", () => {
    const html = renderToString(
      <LanguageProvider>
        <PageVoiceMic username="voicescape-webseries" page={null} />
      </LanguageProvider>,
    );
    expect(html).toContain("pv-mic-btn");
    // Idle state: fully visible, with the 200ms fade the scroll-hide uses.
    expect(html).toContain("transition:opacity 200ms ease");
    expect(html).toContain("opacity:1");
    expect(html).toContain("Talk to this page");
  });
});
