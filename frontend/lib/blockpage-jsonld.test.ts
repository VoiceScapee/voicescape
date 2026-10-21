import { describe, expect, it } from "vitest";
import {
  buildBlockpageJsonLd,
  extractJsonLdInput,
} from "./blockpage-jsonld";
import type { VoicescapePage } from "./schema";

describe("buildBlockpageJsonLd", () => {
  it("expresses a human page as a Person ProfilePage", () => {
    const doc = buildBlockpageJsonLd({
      username: "alice",
      pageUrl: "https://voicescape.vercel.app/alice",
      name: "Alice Builds",
      description: "Builder of small things.",
      ownerType: "human",
    });
    expect(doc["@type"]).toBe("ProfilePage");
    const main = doc.mainEntity as Record<string, unknown>;
    expect(main["@type"]).toBe("Person");
    expect(main.name).toBe("Alice Builds");
    expect(main.alternateName).toBe("alice");
    expect(main.url).toBe("https://voicescape.vercel.app/alice");
    expect(main.description).toBe("Builder of small things.");
  });

  it("expresses an agent page as an Organization and never invents an operator", () => {
    const doc = buildBlockpageJsonLd({
      username: "helperbot",
      pageUrl: "https://voicescape.vercel.app/helperbot",
      ownerType: "agent",
    });
    const main = doc.mainEntity as Record<string, unknown>;
    expect(main["@type"]).toBe("Organization");
    // No operator block on the page => no operator anywhere in the JSON-LD,
    // even though the registry record may hold one.
    expect(JSON.stringify(doc)).not.toContain("operator");
  });

  it("includes the operator ONLY from the page's public operator block", () => {
    const doc = buildBlockpageJsonLd({
      username: "helperbot",
      pageUrl: "https://voicescape.vercel.app/helperbot",
      ownerType: "agent",
      operator: { wallet: "0.0.12345", name: "Kim", url: "https://example.com" },
    });
    const main = doc.mainEntity as Record<string, unknown>;
    const prop = main.additionalProperty as Record<string, unknown>;
    expect(prop.name).toBe("operator");
    expect(prop.value).toBe("0.0.12345");
  });

  it("mirrors public services as offers with USD prices", () => {
    const doc = buildBlockpageJsonLd({
      username: "helperbot",
      pageUrl: "https://voicescape.vercel.app/helperbot",
      ownerType: "agent",
      services: [
        { name: "Audit", description: "A quick audit.", priceUsdCents: 500 },
      ],
    });
    const main = doc.mainEntity as Record<string, unknown>;
    const offers = main.makesOffer as Record<string, unknown>[];
    expect(offers).toHaveLength(1);
    expect(offers[0].name).toBe("Audit");
    expect(offers[0].price).toBe("5.00");
    expect(offers[0].priceCurrency).toBe("USD");
  });

  it("keeps sameAs to http(s) page links and drops the rest", () => {
    const doc = buildBlockpageJsonLd({
      username: "alice",
      pageUrl: "https://voicescape.vercel.app/alice",
      ownerType: "human",
      sameAs: [
        "https://example.com",
        "javascript:alert(1)",
        "not-a-url",
        "https://x.com/alice",
      ],
    });
    expect(doc.sameAs).toEqual(["https://example.com", "https://x.com/alice"]);
  });

  it("falls back to the username when there is no hero title", () => {
    const doc = buildBlockpageJsonLd({
      username: "bob",
      pageUrl: "https://voicescape.vercel.app/bob",
      ownerType: "human",
    });
    expect(doc.name).toBe("bob");
  });
});

describe("extractJsonLdInput (the layout's mapping)", () => {
  const page: VoicescapePage = {
    version: 1,
    username: "helperbot",
    theme: {
      background: "#000",
      foreground: "#fff",
      accent: "#0ff",
      fontFamily: "sans",
    },
    blocks: [
      { type: "hero", title: "Helper Bot" },
      { type: "bio", text: "I audit things." },
      {
        type: "services",
        items: [
          {
            name: "Audit",
            description: "A quick audit.",
            priceUsdCents: 500,
            endpoint: "https://example.com/audit",
          },
        ],
      },
      {
        type: "operator",
        wallet: "0.0.12345",
        name: "Kim",
        url: "https://example.com",
      },
      {
        type: "links",
        items: [{ label: "Site", url: "https://example.com" }],
      },
      {
        type: "socials",
        items: [{ platform: "website", url: "https://example.org" }],
      },
    ],
  };

  it("maps a full page to the enriched input", () => {
    const doc = buildBlockpageJsonLd(
      extractJsonLdInput({
        username: "helperbot",
        pageUrl: "https://voicescape.vercel.app/helperbot",
        ownerType: "agent",
        page,
      }),
    );
    const main = doc.mainEntity as Record<string, unknown>;
    expect(main["@type"]).toBe("Organization");
    expect(doc.name).toBe("Helper Bot");
    expect(main.description).toBe("I audit things.");
    const offers = main.makesOffer as Record<string, unknown>[];
    expect(offers).toHaveLength(1);
    expect(offers[0].price).toBe("5.00");
    const prop = main.additionalProperty as Record<string, unknown>;
    expect(prop.value).toBe("0.0.12345");
    expect(doc.sameAs).toEqual([
      "https://example.com",
      "https://example.org",
    ]);
  });

  it("maps a missing page to the identity core only", () => {
    const doc = buildBlockpageJsonLd(
      extractJsonLdInput({
        username: "helperbot",
        pageUrl: "https://voicescape.vercel.app/helperbot",
        ownerType: "agent",
        page: null,
      }),
    );
    const main = doc.mainEntity as Record<string, unknown>;
    expect(main["@type"]).toBe("Organization");
    expect(doc.name).toBe("helperbot");
    expect(main.description).toBeUndefined();
    expect(main.makesOffer).toBeUndefined();
    expect(doc.sameAs).toBeUndefined();
  });
});
