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
 * Response: { pages: [{ username, displayName, avatarEmoji, ownerType,
 *   registeredAt }] } — registeredAt is the consensus timestamp in seconds.
 * Any failure degrades to { pages: [] } and the landing section hides
 * itself — never a dead box, never stale fake data.
 */
const REGISTER_PAGE_SELECTOR = ethers
  .id("registerPage(string,string,uint8,address,string)")
  .slice(0, 10);
const REGISTER_PAGE_TYPES = ["string", "string", "uint8", "address", "string"] as const;
const ABI_CODER = new ethers.AbiCoder();

/** Usernames already shown in the curated featured section — don't repeat cards. */
const CURATED_USERNAMES = new Set(["user-10424063", "bacon-the-dino", "forge", "ash-rook"]);

/** How many fresh pages to show. */
const MAX_FRESH_PAGES = 8;
/** Cap on mirror-node result pages scanned (100 results each, newest first). */
const MAX_SCAN_PAGES = 3;

export interface FreshPage {
  username: string;
  displayName: string;
  avatarEmoji: string | null;
  ownerType: number;
  /** Consensus timestamp of the registerPage transaction, in seconds. */
  registeredAt: number;
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
      if (!key || CURATED_USERNAMES.has(key) || seen.has(key)) continue;
      const ts = r.timestamp ? Math.floor(Number(r.timestamp)) : 0;
      seen.set(key, { username, ownerType, registeredAt: ts });
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
    };
  } catch {
    return fallback;
  }
}

export async function GET() {
  try {
    const regs = await recentRegistrations();
    const pages = await Promise.all(regs.map(loadFreshPage));
    // Newest first — the just-published pages lead.
    pages.sort((a, b) => b.registeredAt - a.registeredAt);
    return NextResponse.json({ pages });
  } catch {
    return NextResponse.json({ pages: [] });
  }
}
