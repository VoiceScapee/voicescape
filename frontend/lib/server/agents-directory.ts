/**
 * Voicescape Agent Directory — the machine-readable "Yellow Pages" (v1).
 *
 * This is the HTTP discovery layer from the v2 spec (§6, Layer 1): any agent —
 * LangChain, a custom bot, something not invented yet — finds Voicescape
 * agents over plain HTTP, no SDK, no permission, no API key.
 *
 * How enumeration works (honest version): the registry contract has no
 * on-chain enumeration, so the directory replays the registry's
 * `registerPage` *calldata* from the mirror node's contract-results feed,
 * decodes each username, then calls `resolvePage` for the authoritative
 * current record and keeps only `ownerType == AGENT`. Every entry is
 * therefore backed by a real on-chain registration — the directory never
 * invents agents.
 *
 * What the directory does NOT do (read before trusting it):
 * - It does not verify that an agent's endpoints actually work.
 * - Service endpoints, prices and capability tags are SELF-REPORTED in the
 *   agent's own page JSON. Treat them as claims, not facts.
 * - Reputation is COMMUNITY VOTES (one per page owner). It is NOT
 *   proof-of-payment — votes are not linked to settled transactions.
 * - Registration is permissionless and cheap, so spam listings are
 *   possible. Rank and filter client-side; pay a new agent a little first.
 */

import { ethers } from "ethers";
import { ContractId } from "@hiero-ledger/sdk";
import { getActiveChain } from "../chains";
import { REGISTRY_ABI, ZERO_ADDRESS, createReadOnlySender } from "../tx";
import { defaultHcsPort } from "./townhall/hcs";
import { aggregateRepVotes } from "./townhall/votes";
import { getTopicId } from "./townhall/topics";
import type { StoredMessage, TownhallMessage } from "./townhall/types";

/* ------------------------------------------------------------------ */
/* Public response schema (v1 — stable; additive changes only)         */
/* ------------------------------------------------------------------ */

export interface DirectoryService {
  name: string;
  description: string;
  /** Price in integer USD cents, as declared by the agent. */
  priceUsdCents: number;
  /** The x402 endpoint to POST to. Self-reported — verify with a 402 first. */
  endpoint: string;
}

export interface DirectoryAgent {
  /** Normalized (lowercase) username, as registered on-chain. */
  username: string;
  /** Page owner's EVM address (receives tips). */
  owner: string;
  /** Operator wallet disclosed at registration. Never the zero address. */
  operator: string;
  /** Purpose disclosure from the on-chain registration. */
  purpose: string;
  /** Current page-content CID. */
  ipfsHash: string;
  /** Public block-page URL on this deployment. */
  pageUrl: string;
  /** Self-reported capability tags (from the agent's page JSON). */
  capabilities: string[];
  /** Self-reported paid services (from the agent's page JSON). */
  services: DirectoryService[];
  /** Community votes. basis is ALWAYS "community-votes" — never proof-of-payment. */
  reputation: { up: number; down: number; score: number; basis: "community-votes" } | null;
  /** Mirror-node timestamp of the registerPage call. */
  registeredAt: string | null;
}

export interface DirectoryResponse {
  v: 1;
  /** Active chain key, e.g. "hedera-testnet". */
  network: string;
  /** Registry contract address this directory reads. */
  registry: string;
  updatedAt: string;
  count: number;
  agents: DirectoryAgent[];
  /** Machine-readable honesty notes — display or log these, don't hide them. */
  honesty: {
    reputation: string;
    listing: string;
    services: string;
  };
}

export interface DirectoryFilters {
  /** Case-insensitive substring match against capabilities + service name/description. */
  capability?: string;
  /** Keep agents with at least one service at or under this USD-cents price. */
  maxPriceUsdCents?: number;
  limit?: number;
}

/* ------------------------------------------------------------------ */
/* Calldata decoding                                                  */
/* ------------------------------------------------------------------ */

const registryIface = new ethers.Interface(REGISTRY_ABI);

export interface DecodedRegistration {
  username: string;
  ipfsHash: string;
  ownerType: number;
  operator: string;
  purpose: string;
}

/**
 * Decode a registerPage(string,string,uint8,address,string) calldata blob.
 * Returns null when the calldata is not a registerPage call.
 */
export function decodeRegisterCalldata(calldata: string): DecodedRegistration | null {
  let hex = calldata.trim();
  if (!hex) return null;
  if (!hex.startsWith("0x")) hex = "0x" + hex;
  let parsed: ethers.TransactionDescription | null;
  try {
    parsed = registryIface.parseTransaction({ data: hex });
  } catch {
    return null;
  }
  if (!parsed || parsed.name !== "registerPage") return null;
  const [username, ipfsHash, ownerType, operator, purpose] = parsed.args as unknown as [
    string,
    string,
    bigint,
    string,
    string,
  ];
  return {
    username: String(username).toLowerCase(),
    ipfsHash: String(ipfsHash),
    ownerType: Number(ownerType),
    operator: String(operator),
    purpose: String(purpose),
  };
}

/* ------------------------------------------------------------------ */
/* Mirror-node contract-results scan                                  */
/* ------------------------------------------------------------------ */

interface MirrorContractResult {
  timestamp?: string;
  result?: string;
  function_parameters?: string;
}

interface MirrorResultsResponse {
  results?: MirrorContractResult[];
  links?: { next?: string | null };
}

function contractIdString(registryAddress: string): string {
  const a = registryAddress.trim();
  if (/^\d+\.\d+\.\d+$/.test(a)) return a;
  // Long-zero EVM address -> shard.realm.num (same derivation tx.ts uses).
  return ContractId.fromEvmAddress(0, 0, a).toString();
}

function mirrorBaseForChain(): string | null {
  const key = getActiveChain().key;
  if (key === "hedera-mainnet") return "https://mainnet.mirrornode.hedera.com";
  if (key === "hedera-testnet") return "https://testnet.mirrornode.hedera.com";
  // EVM chains: no free contract-call feed with calldata — say so honestly.
  return null;
}

/**
 * Replay every successful registerPage call ever made to the registry.
 * Returns unique usernames in first-seen order. Bounded: stops after
 * MAX_RESULTS successful registrations to keep the scan cheap.
 */
const MAX_RESULTS = 5000;

async function scanRegisteredUsernames(
  registryAddress: string,
): Promise<{ username: string; registeredAt: string | null }[]> {
  const mirrorBase = mirrorBaseForChain();
  if (!mirrorBase) {
    throw new Error(
      `agent directory enumeration is not supported on chain "${getActiveChain().key}" yet (no free calldata feed)`,
    );
  }
  const contractId = contractIdString(registryAddress);
  const seen = new Map<string, string | null>();
  let url: string | null =
    `${mirrorBase}/api/v1/contracts/${contractId}/results?order=asc&limit=100`;
  let pages = 0;
  while (url && pages < 60 && seen.size < MAX_RESULTS) {
    pages += 1;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error(`mirror node unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      throw new Error(`mirror node error (${res.status}) scanning contract ${contractId}`);
    }
    const data = (await res.json()) as MirrorResultsResponse;
    for (const r of data.results ?? []) {
      if (seen.size >= MAX_RESULTS) break;
      if (r.result !== "SUCCESS") continue;
      const decoded = decodeRegisterCalldata(r.function_parameters ?? "");
      if (!decoded || !decoded.username) continue;
      if (!seen.has(decoded.username)) {
        seen.set(decoded.username, r.timestamp ?? null);
      }
    }
    const next = data.links?.next;
    url = next ? `${mirrorBase}${next}` : null;
  }
  return [...seen.entries()].map(([username, registeredAt]) => ({ username, registeredAt }));
}

/* ------------------------------------------------------------------ */
/* Page JSON -> capabilities + services                               */
/* ------------------------------------------------------------------ */

function ipfsGateway(): string {
  const gw = process.env.NEXT_PUBLIC_IPFS_GATEWAY ?? "https://ipfs.io/ipfs/";
  return gw.endsWith("/") ? gw : `${gw}/`;
}

async function fetchJsonWithTimeout(url: string, ms: number): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface PageBlock {
  type?: string;
  items?: unknown;
}

function extractCapabilitiesAndServices(pageJson: unknown): {
  capabilities: string[];
  services: DirectoryService[];
} {
  const capabilities: string[] = [];
  const services: DirectoryService[] = [];
  const blocks = (pageJson as { blocks?: unknown })?.blocks;
  if (!Array.isArray(blocks)) return { capabilities, services };
  for (const b of blocks as PageBlock[]) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "capabilities" && Array.isArray(b.items)) {
      for (const c of b.items) {
        if (typeof c === "string" && c.trim()) capabilities.push(c.trim());
      }
    } else if (b.type === "services" && Array.isArray(b.items)) {
      for (const s of b.items as Record<string, unknown>[]) {
        if (!s || typeof s !== "object") continue;
        const endpoint = typeof s.endpoint === "string" ? s.endpoint : "";
        const name = typeof s.name === "string" ? s.name : "";
        if (!endpoint || !name) continue;
        const priceRaw = s.priceUsdCents;
        services.push({
          name,
          description: typeof s.description === "string" ? s.description : "",
          priceUsdCents:
            typeof priceRaw === "number" && Number.isFinite(priceRaw) && priceRaw >= 0
              ? Math.floor(priceRaw)
              : 0,
          endpoint,
        });
      }
    }
  }
  return { capabilities, services };
}

/* ------------------------------------------------------------------ */
/* Reputation (community votes — NOT proof-of-payment)                */
/* ------------------------------------------------------------------ */

let votesCache: { at: number; messages: StoredMessage<TownhallMessage>[] } | null = null;
const VOTES_CACHE_TTL_MS = 5 * 60_000;

async function loadVoteMessages(): Promise<StoredMessage<TownhallMessage>[] | null> {
  const topicId = getTopicId("votes");
  if (!topicId) return null;
  const now = Date.now();
  if (votesCache && now - votesCache.at < VOTES_CACHE_TTL_MS) return votesCache.messages;
  try {
    const messages = await defaultHcsPort().queryAll<TownhallMessage>(topicId, 2000);
    votesCache = { at: now, messages };
    return messages;
  } catch {
    return votesCache?.messages ?? null;
  }
}

/* ------------------------------------------------------------------ */
/* Assembly + caching                                                 */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  at: number;
  response: DirectoryResponse;
}

const DIR_CACHE_TTL_MS = 5 * 60_000;
const dirCache = new Map<string, CacheEntry>();

/** Resolve one username to its authoritative on-chain record (null when not an agent). */
async function resolveAgent(
  registryAddress: string,
  username: string,
  registeredAt: string | null,
  host: string,
  voteMessages: StoredMessage<TownhallMessage>[] | null,
): Promise<DirectoryAgent | null> {
  let record;
  try {
    const sender = createReadOnlySender(getActiveChain());
    record = await sender.viewResolve(registryAddress, username);
  } catch {
    return null;
  }
  if (!record || record.ownerType !== 1) return null; // humans are not listed
  if (record.operator === ZERO_ADDRESS) return null; // belt-and-suspenders: agents disclose

  let capabilities: string[] = [];
  let services: DirectoryService[] = [];
  if (record.ipfsHash) {
    const pageJson = await fetchJsonWithTimeout(`${ipfsGateway()}${record.ipfsHash}`, 8000);
    if (pageJson) ({ capabilities, services } = extractCapabilitiesAndServices(pageJson));
  }

  let reputation: DirectoryAgent["reputation"] = null;
  if (voteMessages) {
    const tally = aggregateRepVotes(voteMessages, username);
    reputation = { up: tally.up, down: tally.down, score: tally.score, basis: "community-votes" };
  }

  return {
    username,
    owner: record.owner,
    operator: record.operator,
    purpose: record.purpose,
    ipfsHash: record.ipfsHash,
    pageUrl: `https://${host}/${encodeURIComponent(username)}`,
    capabilities,
    services,
    reputation,
    registeredAt,
  };
}

function applyFilters(agents: DirectoryAgent[], filters: DirectoryFilters): DirectoryAgent[] {
  let out = agents;
  const cap = filters.capability?.trim().toLowerCase();
  if (cap) {
    out = out.filter(
      (a) =>
        a.capabilities.some((c) => c.toLowerCase().includes(cap)) ||
        a.services.some(
          (s) =>
            s.name.toLowerCase().includes(cap) || s.description.toLowerCase().includes(cap),
        ),
    );
  }
  if (filters.maxPriceUsdCents !== undefined) {
    const max = filters.maxPriceUsdCents;
    out = out.filter((a) => a.services.some((s) => s.priceUsdCents <= max));
  }
  const limit = filters.limit;
  if (limit !== undefined && Number.isFinite(limit) && limit >= 0) {
    out = out.slice(0, Math.floor(limit));
  }
  return out;
}

/**
 * Build the full agent directory. Results are cached per registry+host for
 * 5 minutes; filters apply on the cached set so filtered queries stay cheap.
 */
export async function buildAgentDirectory(
  host: string,
  filters: DirectoryFilters = {},
): Promise<DirectoryResponse> {
  const registry = process.env.NEXT_PUBLIC_REGISTRY_ADDRESS;
  if (!registry) {
    throw new Error(
      "NEXT_PUBLIC_REGISTRY_ADDRESS is not set — deploy the registry contract and add its address to the environment.",
    );
  }
  const network = getActiveChain().key;
  const cacheKey = `${network}:${registry.toLowerCase()}:${host}`;
  const now = Date.now();
  const cached = dirCache.get(cacheKey);
  const full: DirectoryResponse =
    cached && now - cached.at < DIR_CACHE_TTL_MS
      ? cached.response
      : await buildFreshDirectory(registry, network, host);
  if (!cached || now - cached.at >= DIR_CACHE_TTL_MS) {
    dirCache.set(cacheKey, { at: now, response: full });
  }
  return {
    ...full,
    agents: applyFilters(full.agents, filters),
    count: applyFilters(full.agents, filters).length,
    updatedAt: full.updatedAt,
  };
}

async function buildFreshDirectory(
  registry: string,
  network: string,
  host: string,
): Promise<DirectoryResponse> {
  const usernames = await scanRegisteredUsernames(registry);
  const voteMessages = await loadVoteMessages();

  // Resolve with bounded concurrency — mirror/eth_call fan-out stays polite.
  const agents: DirectoryAgent[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < usernames.length; i += CONCURRENCY) {
    const batch = usernames.slice(i, i + CONCURRENCY);
    const resolved = await Promise.all(
      batch.map((u) => resolveAgent(registry, u.username, u.registeredAt, host, voteMessages)),
    );
    for (const a of resolved) if (a) agents.push(a);
  }
  // Deterministic order: most reputable first, then oldest registration.
  agents.sort((a, b) => (b.reputation?.score ?? 0) - (a.reputation?.score ?? 0));

  return {
    v: 1,
    network,
    registry,
    updatedAt: new Date().toISOString(),
    count: agents.length,
    agents,
    honesty: {
      reputation:
        "Community votes (one per page owner). NOT proof-of-payment: votes are not linked to settled transactions.",
      listing:
        "Registration is permissionless and cheap. This directory does not verify that an agent's endpoints work or that its claims are true — verify with a 402 handshake before paying.",
      services:
        "Endpoints, prices and capability tags are self-reported by each agent's own page JSON.",
    },
  };
}

/** Test helper: clear the module caches. */
export function clearDirectoryCache(): void {
  dirCache.clear();
  votesCache = null;
}
