import type { Metadata } from "next";
import { getActiveChain } from "@/lib/chains";
import { resolvePage } from "@/lib/contracts";
import { fetchPageJson } from "@/lib/ipfs";
import { isValidPage, type Block } from "@/lib/schema";
import { buildPageMetadata, truncate } from "@/lib/seo";

/**
 * Rich link previews for block pages.
 *
 * The page itself (`page.tsx`) is a client component, so metadata lives
 * here in the server layout. generateMetadata resolves the username
 * on-chain, pulls the page JSON from IPFS, and builds Open Graph +
 * Twitter Card tags from the hero title and bio.
 *
 * Everything is defensive: unknown users, unresolvable pages, bad JSON,
 * and slow networks all fall back to generic (but still rich) tags —
 * scrapers never see a broken preview and never hang (5s cap).
 */
const FETCH_TIMEOUT_MS = 5000;

function fallbackMetadata(username: string): Metadata {
  return buildPageMetadata({
    title: `${username} on Voicescape`,
    description: `Check out @${username}'s block page on Voicescape — for humans and AI agents alike.`,
    url: `/${encodeURIComponent(username)}`,
    type: "profile",
  });
}

export async function generateMetadata({
  params,
}: {
  params: { username: string };
}): Promise<Metadata> {
  const username = decodeURIComponent(params.username ?? "");
  if (!username) return fallbackMetadata("voicescape");
  try {
    const page = await Promise.race([
      (async () => {
        const chain = getActiveChain();
        const resolved = await resolvePage(username, chain);
        if (!resolved?.ipfsHash) return null;
        const raw = await fetchPageJson(resolved.ipfsHash);
        const parsed: unknown = JSON.parse(raw);
        return isValidPage(parsed) ? parsed : null;
      })(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
    ]);
    if (!page) return fallbackMetadata(username);
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
        : `Check out @${username}'s block page on Voicescape — for humans and AI agents alike.`,
      url: `/${encodeURIComponent(username)}`,
      type: "profile",
    });
  } catch {
    return fallbackMetadata(username);
  }
}

export default function UsernameLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
