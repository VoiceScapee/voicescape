import { NextRequest, NextResponse } from "next/server";
import { resolvePage } from "@/lib/contracts";
import { CHAINS } from "@/lib/chains";
import { fetchPageJson } from "@/lib/ipfs";
import { getKvStore } from "@/lib/server/store";
import { followerCount } from "@/lib/follows";
import { computeBadges, defaultDepsForBadges } from "@/lib/server/townhall/badges";

export const runtime = "nodejs";
// Featured list changes slowly; 5 minutes keeps the landing page fast
// while follower/badge counts stay fresh enough to be honest.
export const revalidate = 300;

/**
 * GET /api/landing/featured
 *
 * The curated "Featured blockpages" list for the landing page, with live
 * stats per page: follower count, earned badges, and whether the page's
 * livestream block is currently live. Everything is read from the chain,
 * IPFS, and the real follower/badge stores — no hardcoded metrics.
 *
 * Response: { pages: [{ username, displayName, avatarEmoji, ownerType,
 *   followers, badges: [{id,name,icon}], live }] }
 * Sorted by badge count, then followers (most first).
 * A page that fails to resolve is still listed with its username so the
 * section degrades gracefully instead of vanishing.
 */
const FEATURED_USERNAMES = ["user-10424063", "bacon-the-dino", "forge", "ash-rook"];

export interface FeaturedPage {
  username: string;
  displayName: string;
  avatarEmoji: string | null;
  ownerType: number;
  followers: number;
  badges: { id: string; name: string; icon: string }[];
  live: boolean;
}

interface PageBlock {
  type?: string;
  title?: string;
  avatarEmoji?: string;
  platform?: string;
  channel?: string;
}

function heroOf(blocks: PageBlock[]): { title?: string; avatarEmoji?: string } {
  const hero = blocks.find((b) => b?.type === "hero") ?? {};
  return { title: hero.title, avatarEmoji: hero.avatarEmoji };
}

function livestreamChannelOf(blocks: PageBlock[]): string | null {
  const live = blocks.find(
    (b) => b?.type === "livestream" && b.platform === "youtube" && typeof b.channel === "string",
  );
  return live?.channel ?? null;
}

async function checkYouTubeLive(req: NextRequest, channel: string): Promise<boolean> {
  try {
    const url = new URL(`/api/youtube-live?channel=${encodeURIComponent(channel)}`, req.url);
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return false;
    const json = (await res.json()) as { live?: boolean };
    return json.live === true;
  } catch {
    return false;
  }
}

async function loadFeaturedPage(req: NextRequest, username: string): Promise<FeaturedPage> {
  const fallback: FeaturedPage = {
    username,
    displayName: `@${username}`,
    avatarEmoji: null,
    ownerType: 0,
    followers: 0,
    badges: [],
    live: false,
  };
  try {
    const resolved = await resolvePage(username, CHAINS["hedera-mainnet"]);
    if (!resolved?.ipfsHash) return fallback;

    const [pageJsonText, followers, badgeResult] = await Promise.all([
      fetchPageJson(resolved.ipfsHash),
      followerCount(getKvStore(), username).catch(() => 0),
      computeBadges(defaultDepsForBadges().hcs, { username }).catch(() => null),
    ]);

    let blocks: PageBlock[] = [];
    try {
      const parsed = JSON.parse(pageJsonText) as { blocks?: PageBlock[] };
      if (Array.isArray(parsed.blocks)) blocks = parsed.blocks;
    } catch {
      /* keep fallback display info */
    }

    const hero = heroOf(blocks);
    const channel = livestreamChannelOf(blocks);
    const live = channel ? await checkYouTubeLive(req, channel) : false;
    const badges = (badgeResult?.badges ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      icon: b.icon,
    }));

    return {
      username,
      displayName: hero.title || `@${username}`,
      avatarEmoji: hero.avatarEmoji ?? null,
      ownerType: Number(resolved.ownerType ?? 0),
      followers,
      badges,
      live,
    };
  } catch {
    return fallback;
  }
}

export async function GET(req: NextRequest) {
  const pages = await Promise.all(FEATURED_USERNAMES.map((u) => loadFeaturedPage(req, u)));
  // Most badged, then most followed — the pages leading the way, first.
  pages.sort(
    (a, b) => b.badges.length - a.badges.length || b.followers - a.followers,
  );
  return NextResponse.json({ pages });
}
