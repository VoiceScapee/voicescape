import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { resolvePage, getRegistryAddress } from "@/lib/contracts";
import { CHAINS } from "@/lib/chains";
import { fetchPageJson } from "@/lib/ipfs";
import { mirrorBaseUrl } from "@/lib/server/townhall/topics";

export const runtime = "nodejs";
// Fresh list changes as pages publish; 5 minutes keeps the landing page fast
// while new blockpages still surface quickly.
export const revalidate = 300;

/**
 * GET /api/landing/fresh
 *
 * The "Fresh blockpages" list for the landing page: the most recently
 * *published* blockpages on Voicescape, newest first, so new pages get
 * discovered and earn views. Everything is read from the chain (registry
 * contract results), IPFS, and the live resolver — nothing is hardcoded.
 *
 * How it works: the registry's PageRegistered event keeps the username as an
 * indexed topic (only the keccak hash is recoverable from logs), so instead
 * we scan recent registerPage *transactions* on the mirror node and decode
 * the username from the calldata. Failed calls are skipped; re-registrations
 * keep only the latest publish.
 *
 * Pinned pages (PINNED_USERNAMES) always lead the list — resolved live the
 * same way — then recent registrations follow newest-first.
 *
 * Response: { pages: [{ username, displayName, avatarEmoji, ownerType,
 *   registeredAt, pinned }] } — registeredAt is the consensus timestamp in
 * seconds (0 for pinned pages, which aren't new registrations).
 * If the mirror-node scan fails, the pinned showcase pages still resolve
 * live (via the contract + IPFS, independent of the mirror node); the
 * section hides only if nothing at all resolves — never a dead box,
 * never stale fake data.
 */
const REGISTER_PAGE_SELECTOR = ethers
  .id("registerPage(string,string,uint8,address,string)")
  .slice(0, 10);
const REGISTER_PAGE_TYPES = ["string", "string", "uint8", "address", "string"] as const;
const ABI_CODER = new ethers.AbiCoder();

/**
 * Internal test/dev pages — never showcase these as fresh. (Brandon's call
 * 2026-10-08: the landing list is for real new pages earning views.)
 * Add a username here if another test page pops up.
 */
const HIDDEN_USERNAMES = new Set([
  "danny",
  "danny-debug-1",
  "human-test-0913",
  "echo",
  "bacon-the-dino",
  "user-10425049",
  // Brandon's own founder page — re-registered 2026-09-11, not a new page.
  "user-10424063",
]);

/**
 * Always show these pages at the top of the list, resolved live.
 * (Brandon's call 2026-10-08: Ash Rook's music page and Blockpage Buddy
 * belong on the landing page alongside the fresh registrations.)
 * ownerType is the on-chain registration type, used only as a fallback if
 * the live resolve fails — the live lookup always wins.
 */
const PINNED_PAGES: { username: string; ownerType: number }[] = [
  { username: "ash-rook", ownerType: 0 },
  { username: "forge", ownerType: 1 },
];

/** How many fresh pages to show. */
const MAX_FRESH_PAGES = 8;
/** Cap on mirror-node result pages scanned (100 results each, newest first). */
const MAX_SCAN_PAGES = 3;

export interface FreshPage {
  username: string;
  displayName: string;
  avatarEmoji: string | null;
  ownerType: number;
  /** Consensus timestamp of the registerPage transaction, in seconds (0 when pinned). */
  registeredAt: number;
  /** True for the pinned showcase pages — they render without the NEW pill. */
  pinned: boolean;
}

interface ContractResult {
  function_parameters?: string;
  /** null when the call succeeded; set when it reverted. */
  error_message?: string | null;
  /** Consensus timestamp like "1791394487.884407081". */
  timestamp?: string;
}

interface ResultsResponse {
  results?: ContractResult[];
  links?: { next?: string | null };
}

interface PageBlock {
  type?: string;
  title?: string;
  avatarEmoji?: string;
}

function heroOf(blocks: PageBlock[]): { title?: string; avatarEmoji?: string } {
  const hero = blocks.find((b) => b?.type === "hero") ?? {};
  return { title: hero.title, avatarEmoji: hero.avatarEmoji };
}

interface Registration {
  username: string;
  ownerType: number;
  registeredAt: number;
  pinned: boolean;
}

/**
 * Scan recent registry transactions (newest first) for successful
 * registerPage calls. Bounded and fail-open: any mirror-node problem
 * yields an empty list.
 */
async function recentRegistrations(): Promise<Registration[]> {
  const registry = getRegistryAddress();
  if (!registry) return [];
  const seen = new Map<string, Registration>();
  let url: string | null =
    `${mirrorBaseUrl()}/api/v1/contracts/${registry}/results?` +
    new URLSearchParams({ order: "desc", limit: "100" });
  for (let page = 0; page < MAX_SCAN_PAGES && url && seen.size < MAX_FRESH_PAGES; page++) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      break;
    }
    if (!res.ok) break;
    let data: ResultsResponse;
    try {
      data = (await res.json()) as ResultsResponse;
    } catch {
      break;
    }
    for (const r of data.results ?? []) {
      if (r.error_message) continue;
      const params = (r.function_parameters ?? "").replace(/^0x/, "");
      if (!params.startsWith(REGISTER_PAGE_SELECTOR.slice(2))) continue;
      let username = "";
      let ownerType = 0;
      try {
        const decoded = ABI_CODER.decode(REGISTER_PAGE_TYPES, "0x" + params.slice(8));
        username = String(decoded[0] ?? "");
        ownerType = Number(decoded[2] ?? 0);
      } catch {
        continue; // undecodable calldata — skip
      }
      const key = username.toLowerCase();
      if (!key || HIDDEN_USERNAMES.has(key) || seen.has(key)) continue;
      const ts = r.timestamp ? Math.floor(Number(r.timestamp)) : 0;
      seen.set(key, { username, ownerType, registeredAt: ts, pinned: false });
    }
    const next = data.links?.next ?? null;
    url = next ? (next.startsWith("http") ? next : `${mirrorBaseUrl()}${next}`) : null;
  }
  return [...seen.values()].slice(0, MAX_FRESH_PAGES);
}

async function loadFreshPage(reg: Registration): Promise<FreshPage> {
  const fallback: FreshPage = {
    username: reg.username,
    displayName: `@${reg.username}`,
    avatarEmoji: null,
    ownerType: reg.ownerType,
    registeredAt: reg.registeredAt,
    pinned: reg.pinned,
  };
  try {
    const resolved = await resolvePage(reg.username, CHAINS["hedera-mainnet"]);
    if (!resolved?.ipfsHash) return fallback;
    let blocks: PageBlock[] = [];
    try {
      const text = await fetchPageJson(resolved.ipfsHash);
      const parsed = JSON.parse(text) as { blocks?: PageBlock[] };
      if (Array.isArray(parsed.blocks)) blocks = parsed.blocks;
    } catch {
      /* keep fallback display info */
    }
    const hero = heroOf(blocks);
    return {
      username: reg.username,
      displayName: hero.title || `@${reg.username}`,
      avatarEmoji: hero.avatarEmoji ?? null,
      // Prefer the chain's ownerType at resolve time; fall back to the
      // registration transaction's value.
      ownerType: Number(resolved.ownerType ?? reg.ownerType),
      registeredAt: reg.registeredAt,
      pinned: reg.pinned,
    };
  } catch {
    return fallback;
  }
}

export async function GET() {
  try {
    const regs = await recentRegistrations();
    const pinnedNames = new Set(PINNED_PAGES.map((p) => p.username.toLowerCase()));
    // Pinned showcase pages first (Brandon's order), resolved live like the
    // rest; skip any that also appear in recent registrations to avoid dupes.
    const pinned: Registration[] = PINNED_PAGES.filter(
      (p) => !HIDDEN_USERNAMES.has(p.username.toLowerCase()),
    ).map((p) => ({ username: p.username, ownerType: p.ownerType, registeredAt: 0, pinned: true }));
    const fresh = regs.filter((r) => !pinnedNames.has(r.username.toLowerCase()));
    const pages = await Promise.all([...pinned, ...fresh].map(loadFreshPage));
    // Pinned first, then newest-first.
    pages.sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.registeredAt - a.registeredAt,
    );
    return NextResponse.json({ pages });
  } catch {
    return NextResponse.json({ pages: [] });
  }
}
