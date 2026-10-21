import type { Metadata } from "next";
import { cache } from "react";
import { getActiveChain } from "@/lib/chains";
import { resolvePage, type ResolveResult } from "@/lib/contracts";
import { fetchPageJson } from "@/lib/ipfs";
import { isValidPage, type Block, type VoicescapePage } from "@/lib/schema";
import { buildPageMetadata, siteUrl, truncate } from "@/lib/seo";
import {
  buildBlockpageJsonLd,
  extractJsonLdInput,
} from "@/lib/blockpage-jsonld";

/**
 * Rich link previews + machine-readable identity for block pages.
 *
 * The page itself (`page.tsx`) is a client component, so metadata and
 * JSON-LD live here in the server layout. generateMetadata resolves the
 * username on-chain, pulls the page JSON from IPFS, and builds Open Graph
 * + Twitter Card tags from the hero title and bio. The layout renders a
 * ProfilePage JSON-LD script from the SAME resolved data, so AI systems
 * and search engines read the page as what it is: the owner's on-chain
 * identity and one hub — profile, links, music, gallery, booking,
 * services, reviews, tips, marketplace sales, hiring.
 *
 * One resolve per request: the loader is React-cached, so generateMetadata
 * and the layout share a single on-chain resolve + IPFS fetch.
 *
 * Tiered, under one 5s total budget (the previous combined cap, kept so
 * slow networks can never push the render past it):
 *  - resolve succeeds + page JSON arrives in budget → full JSON-LD
 *    (hero, bio, services, operator block, links) and rich metadata.
 *  - resolve succeeds but the page JSON is slow or bad → CORE-ONLY
 *    JSON-LD (username, page URL, human/agent marking — all from the
 *    on-chain record itself, which the page's badge already shows) and
 *    fallback metadata. An identity that resolves must never render
 *    nothing machine-readable just because its IPFS fetch was slow.
 *  - resolve fails → no JSON-LD, fallback metadata. Scrapers never see
 *    a wrong identity claim or a hang.
 *
 * PRIVACY RULE: the JSON-LD mirrors ONLY what the page already shows
 * publicly. The registry record's operator is NOT used — only the page's
 * own public operator block, when the owner chose to publish one.
 */

const FETCH_TIMEOUT_MS = 5000;

interface ResolvedBlockpage {
  resolved: ResolveResult;
  /** Null when the page JSON was slow, unreachable, or invalid — the
   *  caller still gets the on-chain identity core from `resolved`. */
  page: VoicescapePage | null;
}

const loadBlockpage = cache(
  async (username: string): Promise<ResolvedBlockpage | null> => {
    const started = Date.now();
    try {
      const chain = getActiveChain();
      const resolved = await Promise.race([
        resolvePage(username, chain),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), FETCH_TIMEOUT_MS),
        ),
      ]);
      if (!resolved?.ipfsHash) return null;
      const remaining = FETCH_TIMEOUT_MS - (Date.now() - started);
      if (remaining <= 0) return { resolved, page: null };
      const page = await Promise.race([
        (async (): Promise<VoicescapePage | null> => {
          try {
            const raw = await fetchPageJson(resolved.ipfsHash);
            const parsed: unknown = JSON.parse(raw);
            return isValidPage(parsed) ? parsed : null;
          } catch {
            return null;
          }
        })(),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), remaining),
        ),
      ]);
      return { resolved, page };
    } catch {
      return null;
    }
  },
);

function fallbackMetadata(username: string): Metadata {
  // No image override: buildPageMetadata falls back to DEFAULT_OG_IMAGE
  // (the banner). The widget-shot renderer 404s for unknown names, so it
  // must never be the fallback image.
  return buildPageMetadata({
    title: `${username} on Voicescape`,
    description: `Check out @${username}'s blockpage on Voicescape — for humans and AI agents alike.`,
    url: `/${encodeURIComponent(username)}`,
    type: "profile",
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string }>;
}): Promise<Metadata> {
  const { username: rawUsername } = await params;
  const username = decodeURIComponent(rawUsername ?? "");
  if (!username) return fallbackMetadata("voicescape");
  const data = await loadBlockpage(username);
  // Metadata needs the page JSON (hero/bio) — without it, fallback tags,
  // exactly as before. The JSON-LD below still serves its identity core.
  if (!data || !data.page) return fallbackMetadata(username);
  const { page } = data;
  const hero = page.blocks.find(
    (b): b is Extract<Block, { type: "hero" }> => b.type === "hero",
  );
  const bio = page.blocks.find(
    (b): b is Extract<Block, { type: "bio" }> => b.type === "bio",
  );
  const heroTitle = hero?.title?.trim();
  const bioText = bio?.text?.trim();
  return buildPageMetadata({
    title: heroTitle
      ? `${heroTitle} — @${username} on Voicescape`
      : `${username} on Voicescape`,
    description: bioText
      ? truncate(bioText, 200)
      : `Check out @${username}'s blockpage on Voicescape — for humans and AI agents alike.`,
    url: `/${encodeURIComponent(username)}`,
    // Every shared blockpage link unfurls as the branded preview card
    // (username, human/agent badge, 98% tip copy) on Facebook, X, Discord.
    // format=og renders a 1200x630 landscape variant so X's
    // summary_large_image doesn't center-crop the portrait card.
    image: `/api/mcp/widget-shot?username=${encodeURIComponent(username)}&format=og`,
    imageWidth: 1200,
    imageHeight: 630,
    type: "profile",
  });
}

export default async function UsernameLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ username: string }>;
}) {
  const { username: rawUsername } = await params;
  const username = decodeURIComponent(rawUsername ?? "");
  let jsonLd: Record<string, unknown> | null = null;
  if (username) {
    const data = await loadBlockpage(username);
    if (data) {
      const { resolved, page } = data;
      // Page enrichment is optional: when the page JSON arrived in
      // budget, the extractor mirrors its public blocks; when it did
      // not, the identity core (username, URL, human/agent marking)
      // still renders. The mapping itself is unit-tested in
      // lib/blockpage-jsonld.test.ts.
      jsonLd = buildBlockpageJsonLd(
        extractJsonLdInput({
          username,
          pageUrl: `${siteUrl()}/${encodeURIComponent(username)}`,
          ownerType: resolved.ownerType === 1 ? "agent" : "human",
          page,
        }),
      );
    }
  }
  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            // Escape < so a bio containing "</script>" cannot break out
            // of the script element.
            __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
          }}
        />
      )}
      {children}
    </>
  );
}
