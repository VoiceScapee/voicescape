/**
 * ProfilePage JSON-LD for blockpages — the page as an on-chain identity,
 * in the shape search engines and AI systems already read.
 *
 * PRIVACY RULE (hard): this mirrors ONLY what the blockpage already shows
 * publicly. The registry record's operator and purpose are NOT included
 * unless the page's own public blocks disclose them (the page JSON has an
 * "operator" block type for exactly that voluntary disclosure). No treasury
 * internals, no session/auth mechanics, nothing not already visible on
 * the live page.
 *
 * Positioning: the page is presented as the owner's on-chain identity and
 * one hub — profile, links, music, gallery, booking, services, reviews,
 * tips, marketplace sales, hiring — never as a "MySpace-style block page"
 * (always "blockpage") and never as "the only hub".
 *
 * Pure function (no I/O) so it is unit-testable; the [username] layout
 * extracts the public fields from the resolved page JSON and passes them
 * in. Only the builder decides the schema shape.
 */

export interface JsonLdOperator {
  wallet: string;
  name?: string;
  url?: string;
}

export interface JsonLdService {
  name: string;
  description?: string;
  /** Integer USD cents, as declared in the public services block. */
  priceUsdCents?: number;
}

export interface BlockpageJsonLdInput {
  username: string;
  /** Absolute canonical page URL. */
  pageUrl: string;
  /** Hero title, when the page has one. Falls back to the username. */
  name?: string;
  /** Bio text, when the page has one. */
  description?: string;
  /** Shown on the page as the human/agent badge. */
  ownerType: "agent" | "human";
  /** ONLY from the page's public operator block — never from the registry
   *  record alone. */
  operator?: JsonLdOperator;
  /** ONLY from the page's public services block. */
  services?: JsonLdService[];
  /** Public links + socials URLs from the page's blocks. http(s) only. */
  sameAs?: string[];
}

function isHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Extract the builder input from a resolved blockpage. This is the exact
 * mapping the [username] layout uses — kept here (pure, tested) rather
 * than inline in the layout so the enrichment path is covered by unit
 * tests even when a slow IPFS fetch means the live server only renders
 * the identity core.
 *
 * `page` null → identity core only (username, URL, human/agent marking).
 * The registry record's operator is never used; only the page's public
 * operator block feeds `operator`.
 */
export function extractJsonLdInput(args: {
  username: string;
  pageUrl: string;
  ownerType: "agent" | "human";
  page: import("@/lib/schema").VoicescapePage | null;
}): BlockpageJsonLdInput {
  const { username, pageUrl, ownerType, page } = args;
  const core: BlockpageJsonLdInput = { username, pageUrl, ownerType };
  if (!page) return core;
  type Block = import("@/lib/schema").Block;
  const hero = page.blocks.find(
    (b): b is Extract<Block, { type: "hero" }> => b.type === "hero",
  );
  const bio = page.blocks.find(
    (b): b is Extract<Block, { type: "bio" }> => b.type === "bio",
  );
  const services = page.blocks.find(
    (b): b is Extract<Block, { type: "services" }> => b.type === "services",
  );
  const operatorBlock = page.blocks.find(
    (b): b is Extract<Block, { type: "operator" }> => b.type === "operator",
  );
  const sameAs: string[] = [];
  for (const block of page.blocks) {
    if (block.type === "links") {
      for (const item of block.items) sameAs.push(item.url);
    } else if (block.type === "socials") {
      for (const item of block.items) sameAs.push(item.url);
    }
  }
  return {
    ...core,
    name: hero?.title?.trim() || undefined,
    description: bio?.text?.trim() || undefined,
    operator: operatorBlock
      ? {
          wallet: operatorBlock.wallet,
          name: operatorBlock.name || undefined,
          url: operatorBlock.url || undefined,
        }
      : undefined,
    services: services?.items.map((item) => ({
      name: item.name,
      description: item.description,
      priceUsdCents: item.priceUsdCents,
    })),
    sameAs,
  };
}

export function buildBlockpageJsonLd(
  input: BlockpageJsonLdInput,
): Record<string, unknown> {
  const displayName =
    input.name && input.name.trim() ? input.name.trim() : input.username;
  const mainEntity: Record<string, unknown> = {
    "@type": input.ownerType === "agent" ? "Organization" : "Person",
    name: displayName,
    alternateName: input.username,
    url: input.pageUrl,
  };
  if (input.description && input.description.trim()) {
    mainEntity.description = input.description.trim();
  }
  if (input.operator && input.operator.wallet) {
    const prop: Record<string, unknown> = {
      "@type": "PropertyValue",
      name: "operator",
      value: input.operator.wallet,
    };
    if (input.operator.name) prop.description = input.operator.name;
    if (input.operator.url && isHttpUrl(input.operator.url)) {
      prop.url = input.operator.url;
    }
    mainEntity.additionalProperty = prop;
  }
  const offers = (input.services ?? [])
    .filter((s) => s.name && s.name.trim())
    .map((s) => {
      const offer: Record<string, unknown> = {
        "@type": "Offer",
        name: s.name.trim(),
      };
      if (s.description && s.description.trim()) {
        offer.description = s.description.trim();
      }
      if (
        typeof s.priceUsdCents === "number" &&
        Number.isFinite(s.priceUsdCents) &&
        s.priceUsdCents >= 0
      ) {
        offer.price = (s.priceUsdCents / 100).toFixed(2);
        offer.priceCurrency = "USD";
      }
      return offer;
    });
  if (offers.length > 0) {
    mainEntity.makesOffer = offers;
  }

  const doc: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    name: displayName,
    url: input.pageUrl,
    mainEntity,
  };
  const sameAs = (input.sameAs ?? []).filter(isHttpUrl).slice(0, 20);
  if (sameAs.length > 0) {
    doc.sameAs = sameAs;
  }
  return doc;
}
