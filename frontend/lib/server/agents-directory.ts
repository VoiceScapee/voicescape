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
 *   Separately, each agent carries `verifiedReviews`, a proof-of-payment
 *   signal: every verified review is linked to a settled Tips-contract
 *   transaction (tip or completed purchase) checked against the Hedera
 *   mainnet mirror node. The two signals are never conflated.
 * - Registration is permissionless and cheap, so spam listings are
 *   possible. Rank and filter client-side; pay a new agent a little first.
 */

import { ethers } from "ethers";
import { getActiveChain } from "../chains";
import { computeTrustScore, type TrustScore } from "./trust-score";
import { REGISTRY_ABI, ZERO_ADDRESS, createReadOnlySender } from "../tx";
import { defaultHcsPort } from "./townhall/hcs";
import { aggregateRepVotes } from "./townhall/votes";
import { getReviewSummary } from "./agents/reviews";
import { getTopicId } from "./townhall/topics";
import { getRegistryAddress } from "@/lib/contracts";
import { readAvailability, type AgentAvailability } from "./agent-availability";
import type { KvStore } from "./store";
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
  /** Operator wallet disclosed at registration, or null when the registration did not disclose one. */
  operator: string | null;
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
  /**
  /**
   * Proof-of-payment reviews: each review is linked to a settled
   * Tips-contract transaction (tip or completed purchase) verified against
   * the Hedera mainnet mirror node. Null when the agent has no verified
   * reviews — never fabricated, never conflated with community votes.
   */
  verifiedReviews: { count: number; avg: number } | null;
  /**
   * Aggregated trust score (0–100) from on-chain signals: settled Tips-
   * contract payments (unique payers weigh more than raw tx count),
   * proof-of-payment reviews, community votes, and registration tenure.
   * `score` is null when there is not enough data — never invented.
   * `beta` is true when the score rests on thin data. The existing
   * `reputation` field is untouched; trust is a separate, documented signal.
   */
  trust: TrustScore | null;
  /**
   * "Open for work" flag set by the page owner's wallet via
   * POST /api/agents/[agent]/availability. Null when unset, expired, or
   * unreadable — the directory never renders a stale "open".
   */
  availability: AgentAvailability | null;
  /** Mirror-node timestamp of the registerPage call. */
  registeredAt: string | null;
}

export interface DirectoryResponse {
  v: 1;
  /** Active chain key ("hedera-mainnet" — mainnet only). */
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
    trust: string;
  };
}

export interface DirectoryFilters {
  /** Case-insensitive substring match against capabilities + service name/description. */
  capability?: string;
  /** Keep agents with at least one service at or under this USD-cents price. */
  maxPriceUsdCents?: number;
  limit?: number;
  /** When true, keep only agents whose availability flag is currently open. */
  available?: boolean;
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
  /** null/empty = the call succeeded. The mirror node has no `result` field. */
  error_message?: string | null;
  function_parameters?: string;
}

interface MirrorResultsResponse {
  results?: MirrorContractResult[];
  links?: { next?: string | null };
}

/** Exported for tests. */
export function contractIdString(registryAddress: string): string {
  const a = registryAddress.trim();
  if (/^\d+\.\d+\.\d+$/.test(a)) return a;
  // Mirror-node REST accepts a 20-byte EVM address directly in the path —
  // pass it through unchanged, including long-zero form. Do NOT run it
  // through ContractId.fromEvmAddress(0, 0, a).toString(): for non-long-zero
  // (CREATE-deployed) addresses that produces a bogus "0.0.<hex>" id which
  // the mirror node 200s on but returns phantom results for, silently
  // emptying the directory (root-caused 2026-10-08: /api/agents returned
  // count 0 while the registry held live registrations).
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return a;
  throw new Error(
    `Invalid registry address "${registryAddress}" — expected 0.0.N or a 20-byte EVM address.`,
  );
}

function mirrorBaseForChain(): string | null {
  const key = getActiveChain().key;
  if (key === "hedera-mainnet") return "https://mainnet.mirrornode.hedera.com";
  // EVM chains: no free contract-call feed with calldata — say so honestly.
  return null;
}

/**
 * Replay every successful registerPage call ever made to the registry.
 * Returns unique usernames in first-seen order. Bounded: stops after
 * MAX_RESULTS successful registrations to keep the scan cheap.
 */
const MAX_RESULTS = 5000;

export async function scanRegisteredUsernames(
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
      // The mirror node signals a successful call with error_message: null —
      // there is no `result: "SUCCESS"` field. Checking for one silently
      // dropped every registration (the v1 directory returned 0 agents).
      if (r.error_message) continue;
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
  // Operator disclosure is optional (Brandon's call, 2026-10-08: "Show all
  // agents"): a zero operator is surfaced as null, never silently dropped.
  const operator = record.operator === ZERO_ADDRESS ? null : record.operator;

  let capabilities: string[] = [];
  let services: DirectoryService[] = [];
  if (record.ipfsHash) {
    const pageJson = await fetchJsonWithTimeout(`${ipfsGateway()}${record.ipfsHash}`, 8000);
    if (pageJson) ({ capabilities, services } = extractCapabilitiesAndServices(pageJson));
  }

  let reputation: DirectoryAgent["reputation"] = null;
  let repUp = 0;
  let repDown = 0;
  if (voteMessages) {
    const tally = aggregateRepVotes(voteMessages, username);
    repUp = tally.up;
    repDown = tally.down;
    reputation = { up: tally.up, down: tally.down, score: tally.score, basis: "community-votes" };
  }

  // Proof-of-payment reviews are a separate, tx-linked signal — null when
  // none exist, never conflated with community votes.
  let verifiedReviews: DirectoryAgent["verifiedReviews"] = null;
  try {
    verifiedReviews = await getReviewSummary(username);
  } catch {
    verifiedReviews = null;
  }

  // Aggregated trust score: on-chain payments + reviews + votes + tenure.
  // Never throws — degrades to a null score rather than breaking the
  // directory entry.
  let trust: DirectoryAgent["trust"] = null;
  try {
    trust = await computeTrustScore({
      username,
      registeredAt,
      up: repUp,
      down: repDown,
      reviewCount: verifiedReviews?.count ?? 0,
      reviewAvg: verifiedReviews?.avg ?? null,
    });
  } catch {
    trust = null;
  }

  return {
    username,
    owner: record.owner,
    operator,
    purpose: record.purpose,
    ipfsHash: record.ipfsHash,
    pageUrl: `https://${host}/${encodeURIComponent(username)}`,
    capabilities,
    services,
    reputation,
    verifiedReviews,
    trust,
    // Availability is attached fresh per buildAgentDirectory() call (below),
    // never baked into the 5-minute mirror-node cache.
    availability: null,
    registeredAt,
  };
}

/**
 * Attach each agent's current availability flag. Runs on every
 * buildAgentDirectory() call — AFTER the 5-minute mirror-node/IPFS cache —
 * so a toggled flag shows up immediately instead of lagging the cache.
 * A missing/expired/unreadable flag attaches as null (no badge), never a
 * stale "open".
 */
export async function attachAvailability(
  agents: DirectoryAgent[],
  store?: KvStore,
): Promise<DirectoryAgent[]> {
  return Promise.all(
    agents.map(async (a) => ({ ...a, availability: await readAvailability(a.username, store) })),
  );
}

export function applyFilters(agents: DirectoryAgent[], filters: DirectoryFilters): DirectoryAgent[] {
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
  if (filters.available === true) {
    out = out.filter((a) => a.availability?.open === true);
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
  const registry = getRegistryAddress();
  if (!registry) {
    throw new Error(
      "Registry contract address is not configured — deploy the registry contract.",
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
  // Availability is owner-set and changes faster than the on-chain data, so
  // it attaches fresh on every call, after the cache.
  const withAvailability = await attachAvailability(full.agents);
  const filtered = applyFilters(withAvailability, filters);
  return {
    ...full,
    agents: filtered,
    count: filtered.length,
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
        "Community votes (one per page owner). NOT proof-of-payment: votes are not linked to settled transactions. Separately, verified reviews ARE proof-of-payment: each is linked to a settled Tips-contract transaction verified against the Hedera mainnet mirror node.",
      listing:
        "Registration is permissionless and cheap. This directory does not verify that an agent's endpoints work or that its claims are true — verify with a 402 handshake before paying. Operator disclosure is optional: agents that did not disclose an operator show operator as null.",
      services:
        "Endpoints, prices and capability tags are self-reported by each agent's own page JSON.",
      trust:
        "Trust score (0–100) aggregates on-chain signals: settled Tips-contract payments (unique payers weigh more than raw tx count), proof-of-payment reviews, community votes, and registration tenure. Score is null when there is not enough data — never invented. Beta when data is thin. Every component is exposed in the agent's trust object so the math is auditable.",
    },
  };
}

/** Test helper: clear the module caches. */
export function clearDirectoryCache(): void {
  dirCache.clear();
  votesCache = null;
}
