import { describe, expect, it } from "vitest";
import {
  dappSectionFor,
  dappSectionChips,
  dappSectionTitle,
  dappSectionFooter,
} from "./voice-dapp-chips";

describe("dappSectionFor", () => {
  it("maps builder paths", () => {
    expect(dappSectionFor("/builder")).toBe("builder");
    expect(dappSectionFor("/builder/publish")).toBe("builder");
  });
  it("maps agents paths", () => {
    expect(dappSectionFor("/agents")).toBe("agents");
    expect(dappSectionFor("/agents/hire")).toBe("agents");
  });
  it("maps explore paths", () => {
    expect(dappSectionFor("/explore")).toBe("explore");
  });
  it("defaults everything else to home", () => {
    expect(dappSectionFor("/")).toBe("home");
    expect(dappSectionFor("/console")).toBe("home");
    expect(dappSectionFor("/trust")).toBe("home");
    expect(dappSectionFor("/forum")).toBe("home");
  });
});

describe("dappSectionChips", () => {
  it("builder gets exactly the two paths (KISS)", () => {
    const chips = dappSectionChips("builder", "en");
    expect(chips).toEqual(["Build it myself (free)", "Help me build it"]);
    expect(dappSectionChips("builder", "es")).toEqual([
      "Lo hago yo (gratis)",
      "Ayúdame a construirla",
    ]);
  });
  it("agents gets hire/earn/cost chips in both languages", () => {
    expect(dappSectionChips("agents", "en")).toHaveLength(3);
    expect(dappSectionChips("agents", "en")[0]).toBe("How do I hire an agent?");
    expect(dappSectionChips("agents", "es")[0]).toBe("¿Cómo contrato un agente?");
  });
  it("explore gets what-is/agents/tips chips", () => {
    expect(dappSectionChips("explore", "en")).toHaveLength(3);
    expect(dappSectionChips("explore", "en")[0]).toBe("What is Voicescape?");
  });
  it("home keeps the four general chips", () => {
    expect(dappSectionChips("home", "en")).toHaveLength(4);
    expect(dappSectionChips("home", "en")[0]).toBe("What is Voicescape?");
    expect(dappSectionChips("home", "es")[0]).toBe("¿Qué es Voicescape?");
  });
});

describe("dappSectionTitle / dappSectionFooter", () => {
  it("builder gets its own title", () => {
    expect(dappSectionTitle("builder")).toBe("Build your page");
    expect(dappSectionTitle("home")).toBe("Talk to Voicescape");
    expect(dappSectionTitle("agents")).toBe("Talk to Voicescape");
  });
  it("builder footer names the two paths", () => {
    expect(dappSectionFooter("builder")).toContain("free");
    expect(dappSectionFooter("builder")).toContain("AI help");
    expect(dappSectionFooter("home")).toContain("Voicescape");
  });
});
