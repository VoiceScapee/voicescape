/**
 * Mockup top-5 improvements (M1/M2/M4/M5) — focused tests.
 *
 * 1. Typography: FONT_OPTIONS includes Montserrat / DM Sans / IBM Plex Mono
 *    and the legacy fallbacks; theme.fontFamily survives isValidPage.
 * 2. Photo avatars: safeImageUrl accepts https + ipfs://, rejects everything
 *    else; avatarUrl validation in isValidPage matches.
 * 4. Template gallery: filterTemplates search / category / owner visibility /
 *    Featured-first ordering.
 * 5. Trust details: parseCopyLink + truncCopyValue (copy rows),
 *    getJumpNavItems (section jump-nav labels + stable ids).
 *
 * All pure-function tests: no jsdom, no network.
 */
import { describe, expect, it } from "vitest";
import { FONT_OPTIONS, isValidPage, type VoicescapePage } from "./schema";
import { safeImageUrl } from "./url";
import { getJumpNavItems, parseCopyLink, truncCopyValue } from "./page-nav";
import {
  filterTemplates,
  TEMPLATES,
  type Template,
} from "./templates";

function basePage(over: Partial<VoicescapePage> = {}): VoicescapePage {
  return {
    version: 1,
    username: "tester",
    theme: {
      background: "#000",
      foreground: "#fff",
      accent: "#0f0",
      fontFamily: "Arial, sans-serif",
    },
    blocks: [],
    ...over,
  };
}

describe("typography (M1)", () => {
  it("FONT_OPTIONS includes Montserrat, DM Sans, and IBM Plex Mono", () => {
    const labels = FONT_OPTIONS.map((f) => f.label);
    expect(labels).toContain("Montserrat");
    expect(labels).toContain("DM Sans");
    expect(labels).toContain("IBM Plex Mono");
  });

  it("keeps the legacy fallbacks (Arial, monospace, Comic Sans, Impact)", () => {
    const labels = FONT_OPTIONS.map((f) => f.label);
    expect(labels).toContain("Arial");
    expect(labels).toContain("Monospace");
    expect(labels).toContain("Comic Sans");
    expect(labels).toContain("Impact");
  });

  it("every option has a non-empty value + label", () => {
    for (const f of FONT_OPTIONS) {
      expect(f.value.trim().length).toBeGreaterThan(0);
      expect(f.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("theme.fontFamily survives isValidPage for every font option", () => {
    for (const f of FONT_OPTIONS) {
      const page = basePage({
        theme: { background: "#000", foreground: "#fff", accent: "#0f0", fontFamily: f.value },
      });
      expect(isValidPage(page)).toBe(true);
    }
  });
});

describe("safeImageUrl (M2 — HTTPS/IPFS only)", () => {
  const CID_B58 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz6vgtPrYqPx";
  const CID_B32 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

  it("accepts absolute https URLs", () => {
    expect(safeImageUrl("https://example.com/photo.jpg")).toBe("https://example.com/photo.jpg");
    expect(safeImageUrl("  https://example.com/a.png  ")).toBe("https://example.com/a.png");
  });

  it("resolves ipfs:// CIDs to the gateway URL", () => {
    const b58 = safeImageUrl(`ipfs://${CID_B58}`);
    expect(b58).not.toBeNull();
    expect(b58!).toContain(CID_B58);
    expect(b58!).toMatch(/^https:\/\//);
    const b32 = safeImageUrl(`ipfs://${CID_B32}`);
    expect(b32).not.toBeNull();
    expect(b32!).toContain(CID_B32);
  });

  it("rejects http, javascript:, data:, and malformed values", () => {
    expect(safeImageUrl("http://example.com/photo.jpg")).toBeNull();
    expect(safeImageUrl("javascript:alert(1)")).toBeNull();
    expect(safeImageUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeImageUrl("data:image/png;base64,AAA")).toBeNull();
    expect(safeImageUrl("/relative/path.png")).toBeNull();
    expect(safeImageUrl("not a url")).toBeNull();
    expect(safeImageUrl("")).toBeNull();
    expect(safeImageUrl(undefined)).toBeNull();
    expect(safeImageUrl(null)).toBeNull();
    expect(safeImageUrl("ipfs://not-a-cid")).toBeNull();
    expect(safeImageUrl("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz6vgtPrYqPx/evil")).toBeNull();
  });
});

describe("avatarUrl validation in isValidPage (M2)", () => {
  const https = "https://example.com/avatar.png";
  const ipfs = "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz6vgtPrYqPx";

  it("hero accepts https and ipfs:// avatarUrl", () => {
    expect(
      isValidPage(basePage({ blocks: [{ type: "hero", title: "T", avatarUrl: https }] })),
    ).toBe(true);
    expect(
      isValidPage(basePage({ blocks: [{ type: "hero", title: "T", avatarUrl: ipfs }] })),
    ).toBe(true);
  });

  it("hero rejects http / data: / javascript: avatarUrl", () => {
    for (const bad of [
      "http://example.com/a.png",
      "data:image/png;base64,AAA",
      "javascript:alert(1)",
      "ftp://example.com/a.png",
    ]) {
      expect(
        isValidPage(basePage({ blocks: [{ type: "hero", title: "T", avatarUrl: bad }] })),
        bad,
      ).toBe(false);
    }
  });

  it("top8 friend avatars accept https/ipfs and reject the rest", () => {
    const friend = (avatarUrl?: string) => ({ name: "Al", avatarUrl });
    expect(
      isValidPage(basePage({ blocks: [{ type: "top8", friends: [friend(https)] }] })),
    ).toBe(true);
    expect(
      isValidPage(basePage({ blocks: [{ type: "top8", friends: [friend(ipfs)] }] })),
    ).toBe(true);
    expect(
      isValidPage(
        basePage({ blocks: [{ type: "top8", friends: [friend("http://x.com/a.png")] }] }),
      ),
    ).toBe(false);
    expect(
      isValidPage(
        basePage({ blocks: [{ type: "top8", friends: [friend("javascript:x")] }] }),
      ),
    ).toBe(false);
    // Absent avatarUrl stays valid (emoji/initial fallback).
    expect(
      isValidPage(basePage({ blocks: [{ type: "top8", friends: [friend(undefined)] }] })),
    ).toBe(true);
  });
});

function synthTemplate(over: Partial<Template> & { id: string }): Template {
  return {
    category: "personal",
    name: "Synth",
    description: "synthetic template",
    page: basePage(),
    ...over,
  };
}

describe("filterTemplates (M4)", () => {
  const a = synthTemplate({ id: "alpha", category: "personal", name: "Alpha Beats" });
  const b = synthTemplate({ id: "beta", category: "personal", name: "Beta Club", popular: true });
  const c = synthTemplate({ id: "gamma", category: "business", name: "Gamma Shop", featured: true });
  const d = synthTemplate({
    id: "delta",
    category: "personal",
    name: "Delta",
    ownerAccounts: ["0.0.123"],
    featured: true,
  });
  const all = [a, b, c, d];

  it("filters by category", () => {
    const out = filterTemplates(all, { category: "business", query: "", account: null });
    expect(out.map((t) => t.id)).toEqual(["gamma"]);
  });

  it("searches name, description, and id", () => {
    const byName = filterTemplates(all, { category: "personal", query: "alpha", account: null });
    expect(byName.map((t) => t.id)).toEqual(["alpha"]);
    const byDesc = filterTemplates(
      [{ ...a, description: "lofi chill vibes" }],
      { category: "personal", query: "lofi", account: null },
    );
    expect(byDesc).toHaveLength(1);
    const byId = filterTemplates(all, { category: "personal", query: "beta", account: null });
    expect(byId.map((t) => t.id)).toContain("beta");
  });

  it("hides owner-gated templates from other wallets", () => {
    const anon = filterTemplates(all, { category: "personal", query: "", account: null });
    expect(anon.map((t) => t.id)).not.toContain("delta");
    const owner = filterTemplates(all, { category: "personal", query: "", account: "0.0.123" });
    expect(owner.map((t) => t.id)).toContain("delta");
  });

  it("sorts Featured first, then Popular", () => {
    const out = filterTemplates(all, { category: "personal", query: "", account: "0.0.123" });
    const ranks = out.map((t) => t.id);
    // featured (delta) before popular (beta) before plain (alpha)
    expect(ranks.indexOf("delta")).toBeLessThan(ranks.indexOf("beta"));
    expect(ranks.indexOf("beta")).toBeLessThan(ranks.indexOf("alpha"));
  });

  it("empty query returns every visible template in the category", () => {
    const out = filterTemplates(all, { category: "personal", query: "  ", account: "0.0.123" });
    expect(out).toHaveLength(3);
  });

  it("registry: badge flags exist and featured/popular ids are marked", () => {
    const byId = new Map(TEMPLATES.map((t) => [t.id, t]));
    expect(byId.get("aurora-drift")?.featured).toBe(true);
    for (const id of ["lofi-room", "night-signal", "coffee-shop"]) {
      expect(byId.get(id)?.popular, id).toBe(true);
    }
  });
});

describe("copy link rows (M5)", () => {
  it("parseCopyLink extracts the copyable text from copy: URLs", () => {
    expect(parseCopyLink("copy:0.0.10854058")).toBe("0.0.10854058");
    expect(parseCopyLink("copy:  hello  ")).toBe("hello");
    expect(parseCopyLink("https://example.com")).toBeNull();
    expect(parseCopyLink("copy:")).toBeNull();
    expect(parseCopyLink(undefined)).toBeNull();
    expect(parseCopyLink(42)).toBeNull();
  });

  it("truncCopyValue shortens long values for display", () => {
    expect(truncCopyValue("short")).toBe("short");
    const long = "0x1234567890abcdef1234567890abcdef12345678";
    const t = truncCopyValue(long);
    expect(t.length).toBeLessThan(long.length);
    expect(t).toContain("…");
  });
});

describe("jump nav (M5)", () => {
  it("generates labels and stable positional ids for titled sections", () => {
    const items = getJumpNavItems([
      { type: "hero", title: "T" },
      { type: "links", items: [] },
      { type: "music", title: "Anthem", tracks: [] },
      { type: "tipJar" },
      { type: "top8", friends: [] },
      { type: "guestbook", entries: [] },
    ]);
    expect(items).toEqual([
      { id: "pv-section-1", label: "Links" },
      { id: "pv-section-2", label: "Anthem" },
      { id: "pv-section-3", label: "Support" },
      { id: "pv-section-4", label: "Top 8" },
      { id: "pv-section-5", label: "Guestbook" },
    ]);
  });

  it("falls back to default labels when blocks have no custom title", () => {
    const items = getJumpNavItems([
      { type: "music", tracks: [] },
      { type: "services", items: [] },
      { type: "booking", items: [] },
      { type: "reviews", entries: [] },
    ]);
    expect(items.map((i) => i.label)).toEqual(["Music", "Services", "Booking", "Reviews"]);
  });

  it("skips blocks without a display title (hero, bio, gallery)", () => {
    const items = getJumpNavItems([
      { type: "hero", title: "T" },
      { type: "bio", text: "hi" },
      { type: "gallery", images: [] },
    ]);
    expect(items).toEqual([]);
  });
});
