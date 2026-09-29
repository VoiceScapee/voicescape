import { describe, expect, it } from "vitest";
import { TEMPLATES, isTemplateVisible, type Template } from "./templates";

const publicTemplate: Template = {
  id: "public",
  name: "Public",
  description: "public",
  category: "personal",
  page: TEMPLATES[0].page,
};

const privateTemplate: Template = {
  ...publicTemplate,
  id: "private",
  ownerAccounts: ["0.0.10424063", "0x30c63dc43608b6764a6b8b53960553aebf306817"],
};

describe("isTemplateVisible", () => {
  it("shows public templates to everyone, even with no wallet", () => {
    expect(isTemplateVisible(publicTemplate, null)).toBe(true);
    expect(isTemplateVisible(publicTemplate, undefined)).toBe(true);
    expect(isTemplateVisible(publicTemplate, "0.0.999")).toBe(true);
  });

  it("hides owner-gated templates when no wallet is connected", () => {
    expect(isTemplateVisible(privateTemplate, null)).toBe(false);
    expect(isTemplateVisible(privateTemplate, undefined)).toBe(false);
  });

  it("hides owner-gated templates from other wallets", () => {
    expect(isTemplateVisible(privateTemplate, "0.0.12345")).toBe(false);
  });

  it("shows owner-gated templates to the owner in either account form", () => {
    expect(isTemplateVisible(privateTemplate, "0.0.10424063")).toBe(true);
    expect(isTemplateVisible(privateTemplate, "0x30c63dc43608b6764a6b8b53960553aebf306817")).toBe(true);
    // case-insensitive EVM form
    expect(isTemplateVisible(privateTemplate, "0x30C63DC43608B6764A6B8B53960553AEBF306817")).toBe(true);
  });
});

describe("founder template", () => {
  const founder = TEMPLATES.find((t) => t.id === "founder");

  it("exists and is owner-gated to the founder's wallet", () => {
    expect(founder).toBeDefined();
    expect(founder!.ownerAccounts).toContain("0.0.10424063");
    expect(isTemplateVisible(founder!, null)).toBe(false);
    expect(isTemplateVisible(founder!, "0.0.10424063")).toBe(true);
  });

  it("uses the founder's first name only — no family name anywhere", () => {
    const haystack = JSON.stringify(founder!.page).toLowerCase();
    expect(haystack).not.toContain("prout");
    expect(founder!.page.username).toBe("user-10424063");
  });

  it("is one of the owner-gated templates in the gallery", () => {
    const gated = TEMPLATES.filter((t) => t.ownerAccounts && t.ownerAccounts.length > 0);
    expect(gated.map((t) => t.id)).toEqual(["bacon-the-dino", "founder"]);
  });
});

describe("bacon-the-dino template", () => {
  const bacon = TEMPLATES.find((t) => t.id === "bacon-the-dino");

  it("exists, is agent-typed, and is owner-gated to Bacon's wallet", () => {
    expect(bacon).toBeDefined();
    expect(bacon!.page.ownerType).toBe("agent");
    expect(bacon!.ownerAccounts).toContain("0.0.10860063");
    expect(isTemplateVisible(bacon!, null)).toBe(false);
    expect(isTemplateVisible(bacon!, "0.0.12345")).toBe(false);
    expect(isTemplateVisible(bacon!, "0.0.10860063")).toBe(true);
    expect(isTemplateVisible(bacon!, "0x0c243aae85131bf396d3fc4c6005a0f885bd7734")).toBe(true);
  });

  it("carries operator disclosure and an honest empty store", () => {
    const op = bacon!.page.blocks.find((b) => b.type === "operator");
    expect(op).toBeDefined();
    if (op?.type === "operator") {
      // Brandon's wallet, long-zero EVM form.
      expect(op.wallet.toLowerCase()).toBe("0x00000000000000000000000000000000009f0eff");
      // Kimberly is the human behind Bacon — first name only, no family name.
      expect(op.name).toBe("Kimberly");
    }
    expect(bacon!.page.purpose).toBeTruthy();
    const services = bacon!.page.blocks.find((b) => b.type === "services");
    expect(services).toBeDefined();
    if (services?.type === "services") {
      expect(services.items).toEqual([]);
    }
  });

  it("uses the operator's first name only — no family name anywhere", () => {
    const haystack = JSON.stringify(bacon!.page).toLowerCase();
    expect(haystack).not.toContain("prout");
  });

  it("uses only real links and real supported features", () => {
    const links = bacon!.page.blocks.find((b) => b.type === "links");
    expect(links).toBeDefined();
    if (links?.type === "links") {
      for (const item of links.items) {
        expect(item.url).not.toContain("example.com");
        expect(item.url).toMatch(/^https:\/\//);
      }
    }
    // No travel filler from the generic atlas template.
    const haystack = JSON.stringify(bacon!.page).toLowerCase();
    expect(haystack).not.toContain("atlas");
    expect(haystack).not.toContain("compass");
  });
});

describe("quick-build: every template ships a socials block", () => {
  it("every template contains at least one socials block", () => {
    const missing = TEMPLATES.filter(
      (t) => !t.page.blocks.some((b) => b.type === "socials"),
    ).map((t) => t.id);
    expect(missing).toEqual([]);
  });

  it("every socials item has a valid platform and an https URL", () => {
    for (const t of TEMPLATES) {
      for (const b of t.page.blocks) {
        if (b.type !== "socials") continue;
        for (const item of b.items) {
          expect(
            ["x", "instagram", "tiktok", "youtube", "twitch", "facebook", "discord", "linkedin", "github", "website"],
            `template ${t.id}`,
          ).toContain(item.platform);
          expect(item.url, `template ${t.id}`).toMatch(/^https:\/\//);
        }
      }
    }
  });

  it("the business-card template converted its profile links to socials", () => {
    const bc = TEMPLATES.find((t) => t.id === "business-card")!;
    const socials = bc.page.blocks.find((b) => b.type === "socials");
    expect(socials?.type).toBe("socials");
    if (socials?.type === "socials") {
      expect(socials.items.map((i) => i.platform)).toEqual(["github", "linkedin", "x"]);
    }
    expect(bc.page.blocks.some((b) => b.type === "links")).toBe(false);
  });

  it("functional links blocks survive where they do a different job", () => {
    // Restaurant menu/order, cinema schedule, and the founder's on-chain
    // proof links are functional, not profiles — they stay as links, with an
    // empty socials block alongside.
    for (const id of ["restaurant", "movie-theater", "founder"]) {
      const t = TEMPLATES.find((x) => x.id === id)!;
      expect(t.page.blocks.some((b) => b.type === "links"), id).toBe(true);
      expect(t.page.blocks.some((b) => b.type === "socials"), id).toBe(true);
    }
  });
});
