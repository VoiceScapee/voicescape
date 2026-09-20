/**
 * ModHideButton in-app confirm regression tests (source assertions, repo convention).
 *
 * Live failure 2026-09-20: Brandon tapped "Hide" on a comment on his own
 * blockpage wall and nothing happened — no confirm popup, no error. Root
 * cause: the confirm was `window.confirm()`, a native browser dialog that
 * wallet in-app browsers (HashPack's WebView) commonly suppress. A
 * suppressed confirm returns false silently, so the handler exited with
 * zero feedback and the button still read "Hide".
 *
 * The fix replaces the native dialog with an in-app modal (same overlay
 * pattern as TipModal) so the flow works in every WebView. These tests pin
 * that behavior: no native dialog anywhere in the component, a real modal
 * with explicit Cancel/confirm actions, and the unchanged wallet-signed
 * mod-action flow behind the confirm.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "ModHideButton.tsx"), "utf8");
const cssSrc = readFileSync(join(here, "..", "..", "app", "(townhall)", "townhall.css"), "utf8");
// Code without comments — the doc comment above the component mentions
// window.confirm only to explain why it must NOT be used.
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("ModHideButton in-app confirm (no native dialog)", () => {
  it("never calls window.confirm — native dialogs are suppressed in wallet WebViews", () => {
    expect(code).not.toContain("window.confirm");
  });

  it("renders a real dialog with role=dialog and aria-modal", () => {
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
  });

  it("opens the modal on Hide tap instead of confirming inline", () => {
    // The Hide button arms the modal; the actual hide runs from the modal's confirm action.
    expect(src).toMatch(/onClick=\{openConfirm\}/);
    expect(src).toMatch(/const openConfirm = \(\) => \{/);
    expect(src).toMatch(/\{confirming && \(/);
  });

  it("keeps the honest copy: stays on HCS, filtered from reads, permanent", () => {
    expect(src).toContain("It stays on HCS but is");
    expect(src).toContain("filtered from reads for everyone");
    expect(src).toMatch(/can(&apos;|')t be undone/);
  });

  it("offers explicit Cancel and Hide post actions in the modal", () => {
    expect(src).toContain("Cancel");
    expect(src).toContain("Hide post");
    expect(src).toMatch(/onClick=\{closeConfirm\}/);
  });

  it("backdrop tap and the X button close the modal without hiding", () => {
    // Backdrop: only taps directly on the overlay dismiss (not taps inside the dialog).
    expect(src).toMatch(/if \(e\.target === e\.currentTarget\) closeConfirm\(\)/);
    // X button and Cancel are both closeConfirm — neither submits.
    const closes = src.match(/onClick=\{closeConfirm\}/g) ?? [];
    expect(closes.length).toBeGreaterThanOrEqual(2);
  });

  it("hides the floating Buddy button while the confirm modal is open", () => {
    expect(src).toContain("TIP_PANEL_EVENT");
    expect(src).toMatch(
      /window\.dispatchEvent\(new CustomEvent\(TIP_PANEL_EVENT, \{ detail: true \}\)\)/,
    );
  });
});

describe("ModHideButton wallet-signed flow (unchanged behind the confirm)", () => {
  it("signs the hide as an on-chain mod-action before telling the server", () => {
    expect(src).toMatch(/kind: "mod-action"/);
    expect(src).toMatch(/action: "hide"/);
    expect(src).toContain('"/api/townhall/mod-actions"');
  });

  it("reloads the wall via onHidden after a successful hide", () => {
    expect(src).toMatch(/setConfirming\(false\);\s*\n?\s*onHidden\(\);/);
  });

  it("keeps the modal open on wallet cancel so the mod can retry or cancel", () => {
    // hcs.submit returning null = user cancelled in wallet; the modal stays
    // open (no setConfirming(false)) and the phase error is shown inside it.
    expect(src).toMatch(/if \(!hcsTxId\) return; \/\/ User cancelled or error/);
  });

  it("disables dismiss actions and shows progress while submitting", () => {
    expect(src).toMatch(/disabled=\{submitting\}/);
    expect(src).toContain('"Hiding…"');
  });

  it("only renders for authorized moderators, per the mod-status check", () => {
    expect(src).toMatch(/\/api\/townhall\/mod-status/);
    expect(src).toMatch(/if \(!allowed\) return null;/);
  });
});

describe("ModHideButton modal styles", () => {
  it("reuses the town-hall modal overlay styles", () => {
    expect(cssSrc).toContain(".th-modal-overlay");
    expect(cssSrc).toContain(".th-modal");
    expect(cssSrc).toContain(".th-modal-head");
    expect(cssSrc).toContain(".th-icon-btn");
  });
});
