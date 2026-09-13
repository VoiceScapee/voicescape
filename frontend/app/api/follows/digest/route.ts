import { NextRequest, NextResponse } from "next/server";
import { defaultAuthPort } from "@/lib/server/townhall/auth";
import { sessionCredentialFrom } from "@/lib/server/townhall/route-auth";
import { defaultRegistryPort } from "@/lib/server/townhall/registry-check";
import { getKvStore } from "@/lib/server/store";
import {
  decodeTipSentLog,
  TIPSENT_TOPIC,
} from "@/lib/leaderboard";
import {
  mergeDigestItems,
  padTopicAddress,
  readFollowList,
  type DigestItem,
} from "@/lib/follows";
import { defaultDeps, getPosts } from "@/lib/server/townhall/handlers";

export const runtime = "nodejs";

/**
 * GET /api/follows/digest — the signed-in wallet's chronological digest:
 * the latest activity from every page they follow, NEWEST FIRST.
 *
 * Content sources (nothing invented):
 * - tips: on-chain TipSent events TO each followed page's owner, read from
 *   the official Hedera mirror node (same contract + decode path as the
 *   activity feed and leaderboard).
 * - posts: recent Town Hall posts authored BY each followed page's username
 *   (author field), from the forum topic — the only page-authored post
 *   surface that exists.
 *
 * No ranking, no algorithmic ordering, no suggested content — one
 * chronological merge. Response: { items: DigestItem[] }.
 */

const MIRROR = "https://mainnet.mirrornode.hedera.com/api/v1";
const TIPS_CONTRACT = "0.0.10854060";
const MAX_PAGES = 30;
const TIPS_PER_PAGE = 5;
const POSTS_PER_PAGE = 5;
const MAX_ITEMS = 60;
const SNIPPET_LEN = 240;

function mirrorTsToMs(ts: string): number | null {
  const m = /^(\d+)\.(\d+)$/.exec(ts);
  if (!m) return null;
  const ms = Number(m[1]) * 1000 + Math.floor(Number(`0.${m[2]}`) * 1000);
  return Number.isFinite(ms) ? ms : null;
}

interface TipLog {
  topics?: string[];
  data?: string;
  timestamp?: string;
  transaction_hash?: string;
}

/** Resolve a mirror log's transaction hash to a HashScan transaction id. */
async function txIdForLog(log: TipLog): Promise<string> {
  const fallback = typeof log.transaction_hash === "string" ? log.transaction_hash : "";
  if (!log.timestamp) return fallback;
  try {
    const res = await fetch(`${MIRROR}/transactions?timestamp=${encodeURIComponent(log.timestamp)}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return fallback;
    const data: unknown = await res.json();
    const tx = (data as { transactions?: { transaction_id?: string }[] })?.transactions?.[0];
    return tx?.transaction_id || fallback;
  } catch {
    return fallback;
  }
}

interface PageInfo {
  username: string;
  owner: string;
  ownerType: "human" | "agent";
}

/** Recent on-chain tips TO this page's owner. */
async function tipsForPage(page: PageInfo): Promise<DigestItem[]> {
  const items: DigestItem[] = [];
  let logs: TipLog[];
  try {
    const url =
      `${MIRROR}/contracts/${TIPS_CONTRACT}/results/logs` +
      `?order=desc&limit=${TIPS_PER_PAGE}` +
      `&topic0=${TIPSENT_TOPIC}&topic3=${padTopicAddress(page.owner)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" }, next: { revalidate: 60 } });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    logs = ((data as { logs?: TipLog[] })?.logs ?? []).filter((l) => l && typeof l === "object");
  } catch {
    return [];
  }
  for (const log of logs.slice(0, TIPS_PER_PAGE)) {
    const tip = decodeTipSentLog(log);
    if (!tip) continue;
    const tsMs = mirrorTsToMs(tip.timestamp);
    if (tsMs === null) continue;
    // Sanity: the topic filter already pins topic3, but never trust it blindly.
    if (tip.to !== page.owner.toLowerCase()) continue;
    const txId = await txIdForLog(log);
    items.push({
      kind: "tip",
      username: page.username,
      ownerType: page.ownerType,
      from: tip.from,
      amountHbar: tip.amountHbar,
      tsMs,
      txLink: txId ? `https://hashscan.io/mainnet/transaction/${txId}` : null,
    });
  }
  return items;
}

export async function GET(req: NextRequest) {
  const verified = await defaultAuthPort().verifySession(sessionCredentialFrom(req));
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 401 });
  }
  const wallet = verified.session.address;

  try {
    const following = (await readFollowList(getKvStore(), wallet)).slice(0, MAX_PAGES);
    if (following.length === 0) return NextResponse.json({ items: [] });

    // Resolve each followed page on-chain: owner (for the mirror-node tip
    // query) and owner type (so humans and AI agents stay labeled).
    const registry = defaultRegistryPort();
    const pages: PageInfo[] = [];
    for (const username of following) {
      try {
        const page = await registry.resolvePage(username);
        if (page && /^0x[0-9a-fA-F]{40}$/.test(page.owner)) {
          pages.push({
            username,
            owner: page.owner.toLowerCase(),
            ownerType: page.ownerType === 1 ? "agent" : "human",
          });
        }
      } catch {
        // One bad resolution must not kill the whole digest.
      }
    }
    if (pages.length === 0) return NextResponse.json({ items: [] });
    const byUsername = new Map(pages.map((p) => [p.username.toLowerCase(), p]));

    // Tips: one mirror-node query per followed page (topic3 = page owner).
    const tipLists = await Promise.all(pages.map(tipsForPage));
    const tips = tipLists.flat();

    // Posts: one forum read, filtered to posts authored BY followed pages.
    // This is the only page-authored post surface; wall comments by others
    // are not the page's posts and are excluded.
    let posts: DigestItem[] = [];
    try {
      const { status, json } = await getPosts(defaultDeps(), { limit: "100" });
      if (status === 200) {
        const views = (json as { posts?: { author?: string; board?: string; body?: string; ts?: string }[] }).posts ?? [];
        const perPage = new Map<string, number>();
        for (const v of views) {
          const author = typeof v.author === "string" ? v.author.toLowerCase() : "";
          const page = byUsername.get(author);
          if (!page) continue;
          const seen = perPage.get(author) ?? 0;
          if (seen >= POSTS_PER_PAGE) continue;
          const tsMs = typeof v.ts === "string" ? Date.parse(v.ts) : NaN;
          if (!Number.isFinite(tsMs)) continue;
          perPage.set(author, seen + 1);
          const body = typeof v.body === "string" ? v.body : "";
          posts.push({
            kind: "post",
            username: page.username,
            ownerType: page.ownerType,
            board: typeof v.board === "string" && v.board ? v.board : "town-hall",
            body: body.length > SNIPPET_LEN ? body.slice(0, SNIPPET_LEN - 1) + "…" : body,
            tsMs,
          });
        }
      }
    } catch {
      // Posts are a nicety — tips alone still make a valid digest.
    }

    const items = mergeDigestItems([...tips, ...posts]).slice(0, MAX_ITEMS);
    return NextResponse.json({ items });
  } catch (err) {
    console.error("[follows/digest] failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "could not build your digest right now" }, { status: 503 });
  }
}
