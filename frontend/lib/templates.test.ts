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

  it("is the only owner-gated template in the gallery", () => {
    const gated = TEMPLATES.filter((t) => t.ownerAccounts && t.ownerAccounts.length > 0);
    expect(gated.map((t) => t.id)).toEqual(["founder"]);
  });
});
