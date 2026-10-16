/**
 * Page voice mic — deterministic intent router tests.
 *
 * The router is the $0 core of /api/page-voice: it must match intents in
 * en/es, must NEVER offer an intent whose blocks don't exist on the page,
 * and the capability fallback must only list real blocks.
 */
import { describe, expect, it } from "vitest";
import {
  capabilityReply,
  dappCapabilityReply,
  dappChips,
  matchDappIntent,
  matchIntent,
  resolveLang,
  t,
  truncateSentence,
} from "./page-voice-intent";

const FULL = new Set(["hero", "bio", "music", "livestream", "tipJar", "links", "gallery", "booking"]);
const BARE = new Set(["hero", "bio"]);

describe("matchIntent", () => {
  it("matches music in English and Spanish", () => {
    expect(matchIntent("play their music", FULL)?.id).toBe("music");
    expect(matchIntent("pon su música", FULL)?.id).toBe("music");
    expect(matchIntent("show me the songs", FULL)?.id).toBe("music");
  });

  it("matches livestream and prefers it over music for 'música en vivo'", () => {
    expect(matchIntent("are they live?", FULL)?.id).toBe("livestream");
    expect(matchIntent("¿están en vivo?", FULL)?.id).toBe("livestream");
    expect(matchIntent("quiero ver la música en vivo", FULL)?.id).toBe("livestream");
  });

  it("matches tip, bio, gallery, links, booking in both languages", () => {
    expect(matchIntent("leave a tip", FULL)?.id).toBe("tip");
    expect(matchIntent("quiero dar propina", FULL)?.id).toBe("tip");
    expect(matchIntent("tell me their story", FULL)?.id).toBe("bio");
    expect(matchIntent("cuéntame su historia", FULL)?.id).toBe("bio");
    expect(matchIntent("show photos", FULL)?.id).toBe("gallery");
    expect(matchIntent("ver fotos", FULL)?.id).toBe("gallery");
    expect(matchIntent("their links", FULL)?.id).toBe("links");
    expect(matchIntent("sus enlaces", FULL)?.id).toBe("links");
    expect(matchIntent("book them", FULL)?.id).toBe("booking");
    expect(matchIntent("quiero reservar", FULL)?.id).toBe("booking");
  });

  it("never matches an intent whose blocks are missing", () => {
    expect(matchIntent("play their music", BARE)).toBeNull();
    expect(matchIntent("leave a tip", BARE)).toBeNull();
    expect(matchIntent("are they live?", BARE)).toBeNull();
    // bio intent works on the bare page
    expect(matchIntent("their story", BARE)?.id).toBe("bio");
  });

  it("returns null for gibberish", () => {
    expect(matchIntent("blorpt zzz quux", FULL)).toBeNull();
    expect(matchIntent("", FULL)).toBeNull();
  });

  it("socials blocks satisfy the links intent", () => {
    expect(matchIntent("their links", new Set(["socials"]))?.id).toBe("links");
  });
});

describe("resolveLang", () => {
  it("accepts valid codes and falls back sanely", () => {
    expect(resolveLang("es", undefined)).toBe("es");
    expect(resolveLang("xx", undefined)).toBe("en");
    expect(resolveLang(undefined, "es-ES")).toBe("es");
    expect(resolveLang(undefined, "fr-FR")).toBe("fr");
    expect(resolveLang(undefined, "xx")).toBe("en");
    expect(resolveLang(undefined, undefined)).toBe("en");
    expect(resolveLang("", "")).toBe("en");
  });
});

describe("capabilityReply", () => {
  it("lists only blocks the page actually has", () => {
    const { speak } = capabilityReply(FULL, "en");
    expect(speak).toContain("play their music");
    expect(speak).toContain("open the tip box");
    const bare = capabilityReply(BARE, "en");
    expect(bare.speak).toContain("hear their story");
    expect(bare.speak).not.toContain("play their music");
    expect(bare.speak).not.toContain("tip box");
  });

  it("folds hero into the story capability and socials into links", () => {
    const { speak } = capabilityReply(new Set(["hero", "socials"]), "en");
    expect(speak).toContain("hear their story");
    expect(speak).toContain("see their links");
  });

  it("localizes to Spanish", () => {
    const { speak } = capabilityReply(new Set(["music", "tipJar"]), "es");
    expect(speak).toContain("escuchar su música");
    expect(speak).toContain("abrir la caja de propinas");
    expect(speak).toContain(" o ");
  });
});

describe("matchDappIntent", () => {
  it("matches all seven dapp intents in English", () => {
    expect(matchDappIntent("what is voicescape?")?.id).toBe("what-is");
    expect(matchDappIntent("how do I build a page?")?.id).toBe("how-build");
    expect(matchDappIntent("how do tips work?")?.id).toBe("tips");
    expect(matchDappIntent("tell me about AI agents")?.id).toBe("agents");
    expect(matchDappIntent("I want to hire an agent")?.id).toBe("hire");
    expect(matchDappIntent("how much does it cost?")?.id).toBe("cost");
    expect(matchDappIntent("how do I log in?")?.id).toBe("login");
  });

  it("matches dapp intents in Spanish", () => {
    expect(matchDappIntent("¿qué es voicescape?")?.id).toBe("what-is");
    expect(matchDappIntent("¿cómo creo una página?")?.id).toBe("how-build");
    expect(matchDappIntent("quiero dar propina, ¿cómo es el reparto?")?.id).toBe("tips");
    expect(matchDappIntent("quiero contratar un agente")?.id).toBe("hire");
    expect(matchDappIntent("¿cuánto cuesta?")?.id).toBe("cost");
    expect(matchDappIntent("cómo conecto mi billetera")?.id).toBe("login");
  });

  it("prefers the more specific intent (hire over agents, tips over cost)", () => {
    expect(matchDappIntent("hire an AI agent")?.id).toBe("hire");
    // "tips" is checked before "cost" so fee questions land on the 98/2 split
    expect(matchDappIntent("what's the fee on tips?")?.id).toBe("tips");
  });

  it("returns null for gibberish", () => {
    expect(matchDappIntent("blorpt zzz quux")).toBeNull();
    expect(matchDappIntent("")).toBeNull();
  });
});

describe("dapp helpers", () => {
  it("dappChips returns four chips in both languages", () => {
    expect(dappChips("en")).toHaveLength(4);
    expect(dappChips("es")).toHaveLength(4);
    expect(dappChips("en")[0]).toBe("What is Voicescape?");
    expect(dappChips("es")[0]).toBe("¿Qué es Voicescape?");
  });

  it("dappCapabilityReply lists dapp capabilities honestly", () => {
    const { speak } = dappCapabilityReply("en");
    expect(speak).toContain("98/2");
    expect(speak).toContain("hire");
    const es = dappCapabilityReply("es").speak;
    expect(es).toContain("98/2");
  });
});

describe("helpers", () => {
  it("t() falls back to English", () => {
    expect(t("es", "en!", "es!")).toBe("es!");
    expect(t("en", "en!", "es!")).toBe("en!");
    expect(t("ja", "en!", "es!")).toBe("en!");
  });

  it("truncateSentence prefers sentence boundaries", () => {
    expect(truncateSentence("Hello world.")).toBe("Hello world.");
    const long = "First sentence here. " + "x".repeat(300);
    expect(truncateSentence(long, 60)).toBe("First sentence here.");
  });
});
