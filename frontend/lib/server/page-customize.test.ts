/**
 * Tests for page-customize (lib/server/page-customize.ts) — the server-side
 * assembly behind agent-driven custom blockpage claims.
 *
 * Pure: no network, no pinning. The assembly must produce pages that pass
 * the dapp's own isValidPage + content filter, because finalize pins
 * whatever this returns.
 */
import { describe, it, expect } from "vitest";
import {
  assembleClaimPage,
  resolveTemplate,
  sanitizeLinks,
  sanitizeSocials,
  templateCatalog,
  validateCustomTheme,
} from "./page-customize";

const BASE = {
  username: "testagent",
  displayName: "Test Agent",
  purpose: "A test agent that does test things",
  capabilities: ["testing"],
  operator: "0x0000000000000000000000000000000000000001",
};

describe("validateCustomTheme", () => {
  it("accepts valid hex colors and a plain font stack", () => {
    expect(
      validateCustomTheme({
        background: "#141b29",
        foreground: "#fff",
        accent: "#38bdf8",
        fontFamily: "Inter, system-ui, sans-serif",
      }),
    ).toEqual({
      background: "#141b29",
      foreground: "#fff",
      accent: "#38bdf8",
      fontFamily: "Inter, system-ui, sans-serif",
    });
  });

  it("returns {} for null/undefined", () => {
    expect(validateCustomTheme(null)).toEqual({});
    expect(validateCustomTheme(undefined)).toEqual({});
  });

  it("rejects non-hex colors", () => {
    expect(() => validateCustomTheme({ background: "red" })).toThrow(/hex color/);
    expect(() => validateCustomTheme({ accent: "#gggggg" })).toThrow(/hex color/);
    expect(() => validateCustomTheme({ background: "javascript:alert(1)" })).toThrow(/hex color/);
  });

  it("rejects font stacks with CSS breakouts", () => {
    expect(() => validateCustomTheme({ fontFamily: "Arial; color: red" })).toThrow(/font stack/);
    expect(() => validateCustomTheme({ fontFamily: "x{color:red}" })).toThrow(/font stack/);
  });
});

describe("sanitizeSocials / sanitizeLinks", () => {
  it("keeps valid https URLs and normalizes unknown platforms to website", () => {
    const out = sanitizeSocials([
      { platform: "x", url: "https://x.com/test" },
      { platform: "myspace", url: "https://myspace.com/test" },
    ]);
    expect(out).toEqual([
      { platform: "x", url: "https://x.com/test" },
      { platform: "website", url: "https://myspace.com/test" },
    ]);
  });

  it("drops javascript: and bare strings", () => {
    expect(sanitizeSocials([{ platform: "x", url: "javascript:alert(1)" }])).toEqual([]);
    expect(sanitizeSocials([{ platform: "x", url: "not a url" }])).toEqual([]);
  });

  it("caps at 12 and drops bad links", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      label: `L${i}`,
      url: "https://example.com/" + i,
    }));
    expect(sanitizeLinks(many)).toHaveLength(12);
    expect(
      sanitizeLinks([
        { label: "", url: "https://example.com" },
        { label: "ok", url: "javascript:x" },
        { label: "good", url: "https://example.com/good" },
      ]),
    ).toEqual([{ label: "good", url: "https://example.com/good" }]);
  });
});

describe("resolveTemplate", () => {
  it("resolves a known public template", () => {
    expect(resolveTemplate("night-signal", "agent").id).toBe("night-signal");
  });

  it("defaults per owner type", () => {
    expect(resolveTemplate(null, "agent").id).toBe("agent-personal");
    expect(resolveTemplate(undefined, "human").id).toBe("business-card");
  });

  it("rejects unknown and owner-gated templates", () => {
    expect(() => resolveTemplate("nope-not-real", "agent")).toThrow(/unknown template/);
    // "founder" is owner-gated — must not resolve for the public agent flow
    expect(() => resolveTemplate("founder", "agent")).toThrow(/unknown template/);
  });
});

describe("templateCatalog", () => {
  it("lists public templates only, with theme + block types", () => {
    const cat = templateCatalog();
    expect(cat.length).toBeGreaterThan(10);
    expect(cat.find((t) => t.id === "founder")).toBeUndefined();
    const night = cat.find((t) => t.id === "night-signal");
    expect(typeof night?.theme.background).toBe("string");
    expect(night?.theme.background.length).toBeGreaterThan(0);
    expect(night?.block_types).toContain("hero");
  });
});

describe("assembleClaimPage", () => {
  it("builds the classic agent page with no customization (backward compatible)", () => {
    const page = assembleClaimPage({ ...BASE, ownerType: "agent" });
    expect(page.username).toBe("testagent");
    expect(page.ownerType).toBe("agent");
    const hero = page.blocks.find((b) => b.type === "hero") as { title: string };
    expect(hero.title).toBe("Test Agent");
    const op = page.blocks.find((b) => b.type === "operator") as { wallet: string };
    expect(op.wallet).toBe(BASE.operator);
  });

  it("applies socials, links, and a custom theme", () => {
    const page = assembleClaimPage({
      ...BASE,
      ownerType: "agent",
      theme: { background: "#000000", accent: "#ff00ff" },
      socials: [
        { platform: "x", url: "https://x.com/testagent" },
        { platform: "github", url: "https://github.com/testagent" },
      ],
      links: [{ label: "My project", url: "https://example.com/project" }],
    });
    expect(page.theme.background).toBe("#000000");
    expect(page.theme.accent).toBe("#ff00ff");
    // template theme keys not overridden survive
    expect(page.theme.foreground).toBeTruthy();
    const socials = page.blocks.find((b) => b.type === "socials") as { items: unknown[] };
    expect(socials.items).toHaveLength(2);
    const links = page.blocks.find((b) => b.type === "links") as { items: unknown[] };
    expect(links.items).toHaveLength(1);
  });

  it("builds a human page without agent blocks", () => {
    const page = assembleClaimPage({
      ...BASE,
      ownerType: "human",
      socials: [{ platform: "x", url: "https://x.com/testhuman" }],
    });
    expect(page.ownerType).toBe("human");
    expect(page.blocks.find((b) => b.type === "capabilities")).toBeUndefined();
    expect(page.blocks.find((b) => b.type === "operator")).toBeUndefined();
    const socials = page.blocks.find((b) => b.type === "socials") as { items: unknown[] };
    expect(socials.items).toHaveLength(1);
  });

  it("rejects a bad custom theme before pinning", () => {
    expect(() =>
      assembleClaimPage({ ...BASE, ownerType: "agent", theme: { background: "not-a-color" } }),
    ).toThrow(/hex color/);
  });

  it("rejects content the dapp filter would block", () => {
    expect(() =>
      assembleClaimPage({
        ...BASE,
        ownerType: "agent",
        purpose: "call me at 555-010-2030 right now",
      }),
    ).toThrow(/phone numbers/);
  });
});
