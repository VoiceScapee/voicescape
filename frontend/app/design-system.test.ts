/**
 * Design-system regression tests for the "Voicescape at 100 Users" reskin.
 *
 * The reskin is visual-only: these tests pin the approved palette, type,
 * and identity tokens in app/globals.css so a later edit can't silently
 * drift off the approved system (e.g. reintroducing the artifact's
 * misnamed --green violet token).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "globals.css"), "utf8");
const layout = readFileSync(join(here, "layout.tsx"), "utf8");

describe("design-system tokens", () => {
  it("defines the approved near-black navy page base", () => {
    expect(css).toMatch(/--bg:\s*#090b12/);
    expect(css).toMatch(/--panel:\s*#11151d/);
    expect(css).toMatch(/--panel2:\s*#161b27/);
    expect(css).toMatch(/--line:\s*rgba\(255,\s*255,\s*255,\s*0?\.09\)/);
  });

  it("defines the signature palette (violet primary, mint, amber, blue, azure)", () => {
    expect(css).toMatch(/--violet:\s*#8259ef/);
    expect(css).toMatch(/--mint:\s*#91a8ff/);
    expect(css).toMatch(/--amber:\s*#ffca72/);
    expect(css).toMatch(/--blue:\s*#2d84eb/);
    expect(css).toMatch(/--azure:\s*#0031ff/);
    expect(css).toMatch(
      /--gradient:\s*linear-gradient\(118deg,\s*#8259ef 0%,\s*#4f46e5 44%,\s*#0031ff 100%\)/
    );
  });

  it("never defines a --green token (the artifact's violet was misnamed)", () => {
    expect(css).not.toMatch(/--green\s*:/);
    expect(css).not.toMatch(/--vs-green\s*:/);
  });

  it("keeps the --vs-* aliases the components rely on", () => {
    for (const token of [
      "--vs-bg",
      "--vs-panel",
      "--vs-violet",
      "--vs-cyan",
      "--vs-text",
      "--vs-muted",
      "--vs-border",
      "--vs-radius",
      "--vs-gradient",
      "--vs-accent",
      "--vs-font",
      "--vs-mono",
    ]) {
      expect(css, `missing ${token}`).toMatch(new RegExp(`${token}\\s*:`));
    }
  });

  it("maps the legacy --vs-cyan alias to mint (not emerald)", () => {
    expect(css).toMatch(/--vs-cyan:\s*var\(--mint\)/);
    expect(css).not.toMatch(/#10b981|#34d399|#6ee7b7/);
  });

  it("wires the three typefaces through next/font variables", () => {
    expect(layout).toMatch(/Montserrat/);
    expect(layout).toMatch(/DM_Sans/);
    expect(layout).toMatch(/IBM_Plex_Mono/);
    expect(css).toMatch(/--font-display/);
    expect(css).toMatch(/--font-sans/);
    expect(css).toMatch(/--font-mono/);
  });
});

describe("design-system behavior surface", () => {
  it("keeps the reactive transaction UI classes (sound-wave + receipt)", () => {
    for (const cls of [
      ".tx-confirm",
      ".tx-eq",
      ".tx-live-dot",
      ".tx-receipt",
      ".tx-receipt-check",
      ".tx-finality",
      ".tx-rows",
      ".tx-hashscan",
      ".tx-txid",
    ]) {
      expect(css, `missing ${cls}`).toContain(cls);
    }
  });

  it("keeps the human/agent identity classes and the amber hazard strip", () => {
    expect(css).toContain(".vs-avatar-human");
    expect(css).toContain(".vs-avatar-agent");
    expect(css).toContain(".vs-badge-agent");
    expect(css).toContain(".vs-agent-panel");
    expect(css).toMatch(
      /\.vs-hazard\s*{[^}]*linear-gradient\(90deg,\s*#ffca72,\s*#8259ef,\s*#2d84eb\)/
    );
  });

  it("agent avatars are squircles (10px), human avatars are circular", () => {
    expect(css).toMatch(/\.vs-avatar-agent\s*{[^}]*border-radius:\s*10px/);
    expect(css).toMatch(/\.vs-avatar-human\s*{[^}]*border-radius:\s*50%/);
  });

  it("disables pulsing motion under prefers-reduced-motion", () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toMatch(/\.vs-live-dot[\s\S]*?animation:\s*none/);
  });

  it("stat cards carry the 3px gradient accent bar + live badge", () => {
    expect(css).toMatch(/\.vs-stat::before\s*{[^}]*width:\s*3px/);
    expect(css).toContain(".vs-stat-live");
  });
});

describe("landing branding conformance", () => {
  const root = join(here, "..");
  const splash = readFileSync(join(here, "../components/Splash.tsx"), "utf8");
  const landing = readFileSync(join(here, "page.tsx"), "utf8");
  const seo = readFileSync(join(here, "../lib/seo.ts"), "utf8");
  const footer = readFileSync(join(here, "../components/BuiltOnHedera.tsx"), "utf8");

  it("splash hero uses the approved voicescape-logo.webp lockup, not the stale banner", () => {
    expect(splash).toContain("/voicescape-logo.webp");
    expect(splash).not.toContain("voicescape-banner");
  });

  it("stale banner assets are gone; the official Hedera logo asset exists", () => {
    expect(existsSync(join(root, "public/voicescape-banner.png"))).toBe(false);
    expect(existsSync(join(root, "public/voicescape-banner.jpg"))).toBe(false);
    const hedera = readFileSync(join(root, "public/hedera-logo.svg"), "utf8");
    expect(hedera).toContain("<svg");
    // The official asset carries its ™ mark (never redrawn).
    expect(hedera.length).toBeGreaterThan(1000);
  });

  it("share/OG image points at the approved logo, not the stale banner", () => {
    expect(seo).toContain('DEFAULT_OG_IMAGE = "/voicescape-logo.webp"');
    expect(seo).not.toContain("voicescape-banner");
  });

  it("landing footer uses the trademark-compliant Built on Hedera lockup", () => {
    expect(landing).toContain("BuiltOnHedera");
    // Compliant wording — never "powered by".
    expect(footer).toContain("Built on");
    expect(footer).not.toMatch(/powered by/i);
    // Official logo asset (white reverse on dark), never redrawn.
    expect(footer).toContain("/hedera-logo.svg");
    // Voicescape stays more prominent than the Hedera mark.
    expect(footer).toContain("landing.hederaDisclaimer");
  });
});
