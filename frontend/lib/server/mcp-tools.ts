/**
 * Voicescape MCP server — tool implementations (v1).
 *
 * One tier: PUBLIC tools any agent on the internet may call — read-only
 * mirror-node reads plus a single rate-limited intro-posting tool. No
 * auth, no keys, no signing. They describe exactly what they check — no
 * present-tense claims beyond the data returned.
 *
 * All mirror-node access goes through injectable `fetchFn` so tests drive
 * these with fixtures instead of the live network. Production passes the
 * global fetch.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { ethers } from "ethers";
import {
  fetchTipProof,
  tinybarToHbar,
  HASHSCAN_TX_BASE,
  TIPS_CONTRACT_ID,
  type ProofErrorKind,
} from "../tx-proof";
import { TIPS_ABI } from "../tx";
import {
  postAgentIntro as postIntroCore,
  type AgentIntro,
} from "./agent-intros";
import { TEMPLATES } from "../templates";
import { publishPageJson } from "./publish.js";
import { stashClaimPackage } from "./claim-packages";
import {
  assembleClaimPage,
  resolveTemplate,
  templateCatalog,
  validateCustomTheme,
  type ClaimOwnerType,
  type CustomThemeInput,
  type LinkInput,
  type SocialInput,
} from "./page-customize";

export const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";
export const REGISTRY_ID = "0.0.10854058";
export const TREASURY_ID = "0.0.10424063";
/** Registry EVM address (same constant as app/api/resolve/route.ts). */
export const REGISTRY_EVM = "0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58";

const FETCH_TIMEOUT_MS = 10_000;
export const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;

/** Human-readable username rule, shared by the MCP surface for fail-fast errors. */
export const USERNAME_RULE = "3-32 lowercase letters, numbers, _ or -";

const RESOLVE_IFACE = new ethers.Interface([
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
]);
const TIPS_IFACE = new ethers.Interface(TIPS_ABI);
const TIPPAGE_SELECTOR = TIPS_IFACE.getFunction("tipPage")!.selector.toLowerCase();
const BUYLISTING_SELECTOR = TIPS_IFACE.getFunction("buyListing")!.selector.toLowerCase();

/* ------------------------------------------------------------------ */
/* Per-request context (auth + origin), set by the route handler.       */
/* ------------------------------------------------------------------ */

export interface McpRequestContext {
  /** Origin of the incoming request — used for same-app self-fetch. */
  origin: string;
  /** Best-effort client IP (see lib/server/rate-limit.ts trust order). */
  clientIp: string;
}

export const requestContextStorage = new AsyncLocalStorage<McpRequestContext>();

const DEFAULT_CONTEXT: McpRequestContext = {
  origin: "https://voicescape.vercel.app",
  clientIp: "unknown",
};

export function getRequestContext(): McpRequestContext {
  return requestContextStorage.getStore() ?? DEFAULT_CONTEXT;
}

/* ------------------------------------------------------------------ */
/* Tool result helpers                                                 */
/* ------------------------------------------------------------------ */

export interface McpToolResult {
  // Index signature required by the MCP SDK's CallToolResult shape.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

/** Wrap a plain object as an MCP text result (JSON, pretty-printed). */
export function toolResult(obj: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

/** Wrap a PNG buffer as an MCP image result (base64 data URI payload). */
export function imageResult(png: Buffer): McpToolResult {
  return {
    content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }],
  };
}

/** Wrap a plain error message as an MCP error result. Never throws. */
export function toolError(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

/* ------------------------------------------------------------------ */
/* Small fetch helpers                                                 */
/* ------------------------------------------------------------------ */

type FetchFn = typeof fetch;

async function fetchJson(
  fetchFn: FetchFn,
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      ...init,
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/** eth_call-style read through the mirror node's contracts/call endpoint. */
async function mirrorContractCall(
  fetchFn: FetchFn,
  to: string,
  data: string,
): Promise<string> {
  const { ok, body } = await fetchJson(fetchFn, `${MIRROR_BASE}/contracts/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, data, gas: 100_000 }),
  });
  if (!ok || !body || typeof body.result !== "string" || body.result === "0x") {
    throw new Error("contract call failed");
  }
  return body.result as string;
}

/* ------------------------------------------------------------------ */
/* PUBLIC tool 1: lookup_blockpage                                     */
/* ------------------------------------------------------------------ */

export interface BlockpageLookup {
  found: boolean;
  username: string;
  owner_evm?: string;
  owner_account?: string | null;
  ipfs_hash?: string;
  owner_type?: "human" | "agent";
  operator?: string;
  purpose?: string;
}

/**
 * Resolve a Voicescape username via the Registry contract's resolvePage
 * (mirror-node eth_call). Best-effort follow-up maps the owner's EVM
 * address to its 0.0.x account id. Returns { found: false } for unknown
 * names — never throws internals.
 */
export async function lookupBlockpage(
  username: string,
  fetchFn: FetchFn = fetch,
): Promise<BlockpageLookup> {
  const name = username.trim().toLowerCase();
  if (!USERNAME_RE.test(name)) {
    return { found: false, username: name };
  }
  let raw: string;
  try {
    raw = await mirrorContractCall(
      fetchFn,
      REGISTRY_EVM,
      RESOLVE_IFACE.encodeFunctionData("resolvePage", [name]),
    );
  } catch {
    // Contract reverts for unregistered names.
    return { found: false, username: name };
  }
  let decoded: [string, string, bigint, string, string];
  try {
    decoded = RESOLVE_IFACE.decodeFunctionResult("resolvePage", raw) as unknown as typeof decoded;
  } catch {
    return { found: false, username: name };
  }
  const [owner, ipfsHash, ownerType, operator, purpose] = decoded;
  const ownerEvm = owner.toLowerCase();

  // Best-effort: EVM address -> 0.0.x account id. Fail-soft.
  let ownerAccount: string | null = null;
  try {
    const { ok, body } = await fetchJson(fetchFn, `${MIRROR_BASE}/accounts/${ownerEvm}`);
    if (ok && body && typeof body.account === "string") ownerAccount = body.account;
  } catch {
    /* keep null */
  }

  return {
    found: true,
    username: name,
    owner_evm: ownerEvm,
    owner_account: ownerAccount,
    ipfs_hash: ipfsHash,
    owner_type: Number(ownerType) === 1 ? "agent" : "human",
    operator: operator.toLowerCase(),
    purpose,
  };
}

/* ------------------------------------------------------------------ */
/* PUBLIC tool: check_profile_pin (pin-status companion to lookup)      */
/* ------------------------------------------------------------------ */

export interface ProfilePinCheck {
  username?: string;
  cid: string;
  reachable: boolean;
  bytes_fetched: number;
  content_type: string | null;
  gateway: string | null;
  truncated: boolean;
  checked_at: string;
  note: string | null;
}

/** CIDv0 (Qm…) or CIDv1 (baf…) — the only forms the Registry ever stores. */
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{50,100})$/;
/** Pinata first: the dapp pins profile JSON through Pinata server-side. */
const PIN_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
];
const PIN_FETCH_TIMEOUT_MS = 10_000;
/** Blockpage JSON is a few KB — cap the read so a hostile CID can't blow memory. */
const PIN_MAX_BYTES = 256 * 1024;

function pinCheckResult(
  partial: Partial<ProfilePinCheck> & { cid: string; reachable: boolean },
): ProfilePinCheck {
  return {
    username: partial.username,
    cid: partial.cid,
    reachable: partial.reachable,
    bytes_fetched: partial.bytes_fetched ?? 0,
    content_type: partial.content_type ?? null,
    gateway: partial.gateway ?? null,
    truncated: partial.truncated ?? false,
    checked_at: new Date().toISOString(),
    note: partial.note ?? null,
  };
}

/**
 * Pin-status companion to lookup_blockpage. The Registry stores only a CID
 * pointer, never the content — this tool actually fetches the bytes through
 * public IPFS gateways and reports whether the profile loads. Returns
 * { error } when called with neither a username nor a cid; never throws.
 */
export async function checkProfilePin(
  args: { username?: string; cid?: string },
  fetchFn: FetchFn = fetch,
): Promise<ProfilePinCheck | { error: string }> {
  let cid = (args.cid ?? "").trim();
  const username = (args.username ?? "").trim().toLowerCase() || undefined;

  if (!cid && username) {
    if (!USERNAME_RE.test(username)) return { error: "invalid username" };
    const page = await lookupBlockpage(username, fetchFn);
    if (!page.found || !page.ipfs_hash) {
      return pinCheckResult({
        username,
        cid: "",
        reachable: false,
        note: "username not registered on-chain (or no profile CID stored)",
      });
    }
    cid = page.ipfs_hash;
  }
  if (!cid) return { error: "pass a username or a cid" };
  if (!CID_RE.test(cid)) {
    return pinCheckResult({
      username,
      cid,
      reachable: false,
      note: "not a recognized IPFS CID (expected Qm… or baf…)",
    });
  }

  for (const gw of PIN_GATEWAYS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PIN_FETCH_TIMEOUT_MS);
    try {
      const res = await fetchFn(gw + cid, { signal: ctrl.signal });
      if (!res.ok || !res.body) continue;
      const reader = res.body.getReader();
      let bytes = 0;
      let truncated = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes >= PIN_MAX_BYTES) {
            // Clamp: a single chunk can overshoot the cap — report the cap,
            // not the overshoot, since the read stops here.
            bytes = PIN_MAX_BYTES;
            truncated = true;
            break;
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
      }
      return pinCheckResult({
        username,
        cid,
        reachable: true,
        bytes_fetched: bytes,
        content_type: res.headers.get("content-type"),
        gateway: gw,
        truncated,
        note: truncated ? "content larger than 256KB — read truncated" : null,
      });
    } catch {
      /* gateway failed or timed out — try the next one */
    } finally {
      clearTimeout(timer);
    }
  }
  return pinCheckResult({
    username,
    cid,
    reachable: false,
    note: "CID not retrievable from public IPFS gateways (unpinned or gateway issue)",
  });
}

/* ------------------------------------------------------------------ */
/* PUBLIC tool 2: verify_tip                                           */
/* ------------------------------------------------------------------ */

const PROOF_ERROR_MESSAGES: Record<ProofErrorKind, string> = {
  malformed:
    "not a Hedera transaction id — expected 0.0.x@seconds.nanos or 0.0.x-seconds-nanos",
  "not-found":
    "transaction not found on the mirror node (it may not have reached consensus yet)",
  "not-a-tip": `exists but is not a successful tip call to the Tips contract ${TIPS_CONTRACT_ID}`,
  reverted: `called the Tips contract ${TIPS_CONTRACT_ID} but reverted on-chain`,
  network: "mirror node unreachable — try again in a moment",
  decode: "the chain answered but the tip data was unreadable",
};

export interface TipVerification {
  is_tip: boolean;
  reason?: string;
  transaction_id?: string;
  status?: string;
  sender_evm?: string;
  recipient_evm?: string;
  gross_hbar?: string;
  creator_hbar?: string;
  treasury_hbar?: string;
  split_exact_98_2?: boolean;
  treasury_account?: string;
  contract?: string;
  consensus_timestamp?: string;
  hashscan?: string;
}

/**
 * Verify a transaction id against the Tips contract: confirms the call
 * target, consensus success, and decodes the on-chain TipSent event into
 * the exact 98/2 split. Accepts both SDK id forms. Never invents a split —
 * a Tips-contract call without a TipSent event (e.g. a marketplace
 * purchase) is honestly reported as not-a-tip.
 */
export async function verifyTip(
  transactionId: string,
  fetchFn: FetchFn = fetch,
): Promise<TipVerification> {
  const result = await fetchTipProof(transactionId, fetchFn);
  if (!result.ok) {
    return { is_tip: false, reason: PROOF_ERROR_MESSAGES[result.error] };
  }
  const p = result.proof;
  return {
    is_tip: true,
    transaction_id: p.txId,
    status: "SUCCESS",
    sender_evm: p.sender,
    recipient_evm: p.recipient,
    gross_hbar: tinybarToHbar(p.grossTinybar),
    creator_hbar: tinybarToHbar(p.grossTinybar - p.feeTinybar),
    treasury_hbar: tinybarToHbar(p.feeTinybar),
    split_exact_98_2: p.splitExact,
    treasury_account: TREASURY_ID,
    contract: TIPS_CONTRACT_ID,
    consensus_timestamp: p.consensusTimestamp,
    hashscan: `${HASHSCAN_TX_BASE}/${p.txId}`,
  };
}

/* ------------------------------------------------------------------ */
/* PUBLIC tool 3: treasury_stats                                       */
/* ------------------------------------------------------------------ */

export interface TreasuryInbound {
  from: string | null;
  amount_hbar: string;
  consensus_timestamp: string;
  transaction_id: string;
}

export interface TreasuryStats {
  treasury: string;
  balance_hbar: string | null;
  recent_inbound: TreasuryInbound[];
  note: string;
}

/**
 * Treasury account balance plus the most recent inbound fee transfers,
 * read live from the mirror node. Inbound attribution picks the largest
 * net sender per transaction as the counterparty.
 */
export async function treasuryStats(
  fetchFn: FetchFn = fetch,
): Promise<TreasuryStats> {
  const empty: TreasuryStats = {
    treasury: TREASURY_ID,
    balance_hbar: null,
    recent_inbound: [],
    note: "balances and transfers read live from the Hedera mainnet mirror node",
  };

  const acct = await fetchJson(fetchFn, `${MIRROR_BASE}/accounts/${TREASURY_ID}`);
  if (acct.ok && acct.body && typeof acct.body?.balance?.balance === "number") {
    empty.balance_hbar = tinybarToHbar(BigInt(acct.body.balance.balance));
  } else {
    return empty;
  }

  const txs = await fetchJson(
    fetchFn,
    `${MIRROR_BASE}/transactions?account.id=${TREASURY_ID}&limit=25&order=desc`,
  );
  if (!txs.ok || !Array.isArray(txs.body?.transactions)) return empty;

  for (const tx of txs.body.transactions as Array<Record<string, any>>) {
    const transfers: Array<{ account: string; amount: number }> = Array.isArray(tx.transfers)
      ? tx.transfers
      : [];
    const inbound = transfers.find((t) => t.account === TREASURY_ID && t.amount > 0);
    if (!inbound) continue;
    let from: string | null = null;
    let mostNegative = 0;
    for (const t of transfers) {
      if (t.amount < mostNegative) {
        mostNegative = t.amount;
        from = t.account;
      }
    }
    empty.recent_inbound.push({
      from,
      amount_hbar: tinybarToHbar(BigInt(Math.round(inbound.amount))),
      consensus_timestamp: typeof tx.consensus_timestamp === "string" ? tx.consensus_timestamp : "",
      transaction_id: typeof tx.transaction_id === "string" ? tx.transaction_id : "",
    });
    if (empty.recent_inbound.length >= 10) break;
  }
  return empty;
}

/* ------------------------------------------------------------------ */
/* PUBLIC tool 4: recent_tips                                          */
/* ------------------------------------------------------------------ */

export interface RecentTip {
  timestamp: string;
  from: string;
  amount_hbar: string;
  kind: "tip" | "marketplace_purchase" | "other";
  transaction_id: string | null;
}

export interface RecentTips {
  contract: string;
  tips: RecentTip[];
  note: string;
}

/**
 * Latest successful contract calls touching the Tips contract (tips and
 * marketplace purchases), most recent first. Reads the mirror-node
 * contract-results feed; `limit` is clamped to 1..25.
 */
export async function recentTips(
  limit: number,
  fetchFn: FetchFn = fetch,
): Promise<RecentTips | { error: string }> {
  const n = Math.floor(limit);
  if (!Number.isFinite(n) || n < 1 || n > 25) {
    return { error: "limit must be an integer between 1 and 25" };
  }
  const { ok, body } = await fetchJson(
    fetchFn,
    `${MIRROR_BASE}/contracts/${TIPS_CONTRACT_ID}/results?limit=${n}&order=desc`,
  );
  const out: RecentTips = {
    contract: TIPS_CONTRACT_ID,
    tips: [],
    note: "latest successful calls touching the Tips contract (tips and marketplace purchases), most recent first, read live from the mirror node",
  };
  if (!ok || !Array.isArray(body?.results)) return out;
  for (const row of body.results as Array<Record<string, any>>) {
    // The contract-results endpoint signals failure via a non-empty
    // error_message (see lib/server/chain-stats.ts).
    if (row.error_message) continue;
    const params: string = typeof row.function_parameters === "string" ? row.function_parameters : "";
    const selector = params.slice(0, 10).toLowerCase();
    const kind =
      selector === TIPPAGE_SELECTOR
        ? "tip"
        : selector === BUYLISTING_SELECTOR
          ? "marketplace_purchase"
          : "other";
    out.tips.push({
      timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
      from: typeof row.from === "string" ? row.from : "",
      amount_hbar: tinybarToHbar(BigInt(Math.round(Number(row.amount ?? 0)))),
      kind,
      transaction_id:
        typeof row.transaction_id === "string"
          ? row.transaction_id
          : typeof row.hash === "string"
            ? row.hash
            : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* PUBLIC tool 5: search_agents                                        */
/* ------------------------------------------------------------------ */

export interface AgentMatch {
  username: string;
  purpose: string;
  owner: string | null;
  /**
   * "Open for work" flag, owner-set via POST /api/agents/[agent]/availability.
   * Null when unset or expired — never a stale "open". Self-reported like
   * everything else in the listing.
   */
  availability: { open: boolean; updatedAt: string } | null;
}

export interface AgentSearch {
  query: string;
  matches: AgentMatch[];
  total_in_directory: number;
  note: string;
}

/**
 * Search the on-chain agent directory (reuses the app's own
 * /api/agents/directory, which carries the 15-minute server-side cache).
 * Listings are self-reported by the agents — endpoints and prices are
 * claims; verify before paying.
 */
export async function searchAgents(
  query: string,
  fetchFn: FetchFn = fetch,
  origin?: string,
): Promise<AgentSearch> {
  const q = query.trim().toLowerCase();
  const base = origin ?? getRequestContext().origin;
  const out: AgentSearch = {
    query: query.trim(),
    matches: [],
    total_in_directory: 0,
    note: "agent listings are self-reported on-chain registrations; service endpoints and prices are claims, not verified facts — verify before paying",
  };
  if (!q) return out;
  const { ok, body } = await fetchJson(fetchFn, `${base}/api/agents/directory`);
  if (!ok || !Array.isArray(body?.agents)) return out;
  const agents = body.agents as Array<Record<string, any>>;
  out.total_in_directory = agents.length;
  for (const a of agents) {
    const username = typeof a.username === "string" ? a.username : "";
    const purpose = typeof a.purpose === "string" ? a.purpose : "";
    if (username.toLowerCase().includes(q) || purpose.toLowerCase().includes(q)) {
      const rawAvail = a.availability as { open?: unknown; updatedAt?: unknown } | null | undefined;
      const availability =
        rawAvail && typeof rawAvail === "object" && typeof rawAvail.open === "boolean" && typeof rawAvail.updatedAt === "string"
          ? { open: rawAvail.open, updatedAt: rawAvail.updatedAt }
          : null;
      out.matches.push({
        username,
        purpose,
        owner: typeof a.owner === "string" ? a.owner : null,
        availability,
      });
    }
    if (out.matches.length >= 20) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* PUBLIC tool 6: post_agent_intro (no auth — one intro per IP per day)  */
/* ------------------------------------------------------------------ */

export interface IntroPosted {
  posted: true;
  handle: string;
  claim_code: string;
  created_at: string;
  board: string;
  message: string;
}

/**
 * Post one agent intro to the public /intros board. No signup, no wallet,
 * no auth — but strictly one intro per IP per 24 hours, text-only
 * (Brandon's rule: links belong on the blockpage, not in the intro).
 * Returns a claim code the agent saves and later links to its blockpage.
 */
export async function postAgentIntro(
  handle: string,
  text: string,
): Promise<IntroPosted | { error: string }> {
  const clientIp = getRequestContext().clientIp;
  const res = await postIntroCore({ handle, text, clientIp });
  if (!res.ok) return { error: res.error };
  const intro: AgentIntro = res.intro;
  return {
    posted: true,
    handle: intro.handle,
    claim_code: intro.claim_code,
    created_at: intro.created_at,
    board: "/intros",
    message:
      `Intro posted! Save this claim code: ${intro.claim_code}. ` +
      "When you connect your wallet and build your blockpage, use it to link " +
      "this intro as your first post. Intros are shown as unverified until linked.",
  };
}

/* ------------------------------------------------------------------ */
/* PUBLIC tool 8: prepare_agent_claim — Sovereign-mode onboarding      */
/* ------------------------------------------------------------------ */

export interface AgentClaimPackage {
  username: string;
  /** The owner override, or null — then the wallet that taps approve owns it. */
  owner_account_id: string | null;
  /** Explicit 0x operator override, or null (defaults to the payer's address). */
  operator: string | null;
  purpose: string;
  page_url: string;
  /** Short id behind the approval link. */
  claim_package_id: string;
  /** The one-tap approval link the agent hands the human. */
  approve_url: string;
  /** Intro claim code to auto-link after registration, or null. */
  intro_claim_code: string | null;
  owner_funded: boolean | null;
  owner_balance_hbar: number | null;
  what_youre_signing: string;
  next: string;
}

export interface PrepareAgentClaimArgs {
  username: string;
  /**
   * OPTIONAL override. When omitted, the page registers to whatever wallet
   * taps approve on the link — the human never types an account id.
   */
  owner_account_id?: string;
  operator?: string;
  purpose: string;
  display_name?: string;
  capabilities?: string[];
  /** Claim code from post_agent_intro — auto-linked after registration. */
  intro_claim_code?: string;
  /**
   * "human" or "agent" page. Default "agent". A human page gets the
   * human starter layout (hero/bio/socials/links) instead of the
   * agent one (capabilities/operator) — same one-tap claim flow.
   */
  owner_type?: string;
  /** Template id from list_templates (any custom layout start). */
  template_id?: string;
  /** Freeform theme override — custom colors/font on the template's vibe. */
  theme?: CustomThemeInput;
  /** Social profiles to link: [{platform, url}]. Platform auto-detected. */
  socials?: SocialInput[];
  /** Arbitrary project links: [{label, url}]. */
  links?: LinkInput[];
}

/** Resolve a 0.0.x account's EVM address (long-zero fallback). Fail-soft. */
export async function evmAddressForAccount(
  accountId: string,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  try {
    const { ok, body } = await fetchJson(fetchFn, `${MIRROR_BASE}/accounts/${accountId}`);
    const evm = ok && body && typeof body?.evm_address === "string" ? body.evm_address : null;
    if (evm && /^0x[0-9a-fA-F]{40}$/.test(evm)) return evm.toLowerCase();
  } catch {
    /* fall through to long-zero */
  }
  return "0x" + BigInt(accountId.split(".")[2]).toString(16).padStart(40, "0");
}

export interface AgentPageSpec {
  username: string;
  ownerType: ClaimOwnerType;
  displayName: string;
  purpose: string;
  capabilities: string[];
  operator: string;
  templateId?: string | null;
  theme?: CustomThemeInput | null;
  socials?: SocialInput[] | null;
  links?: LinkInput[] | null;
}

/**
 * Build + pin the claim page (server-side Pinata, like /api/agents/onboard).
 * Called at FINALIZE time — pinning at prepare time orphans a page every
 * time the human never taps. Assembles from the template + customization via
 * page-customize, which runs the same gates as /api/pin (isValidPage +
 * content filter) before anything is pinned.
 */
export async function pinAgentPage(spec: AgentPageSpec): Promise<string> {
  const page = assembleClaimPage({
    username: spec.username,
    ownerType: spec.ownerType,
    displayName: spec.displayName,
    purpose: spec.purpose,
    capabilities: spec.capabilities,
    operator: spec.operator,
    templateId: spec.templateId,
    theme: spec.theme,
    socials: spec.socials,
    links: spec.links,
  });
  const result = (await publishPageJson(page)) as { cid: string };
  return result.cid;
}

/** Public template catalog for the list_templates MCP tool. */
export function listTemplates() {
  return templateCatalog();
}

/**
 * Prepare an agent-blockpage claim as a one-tap approval link — the
 * Sovereign mode: the human's EXISTING wallet owns the agent page — no
 * new wallet, no new seed phrase, no wallet-switching.
 *
 * The agent calls this with a username and purpose (the owner's account id
 * is an OPTIONAL override). The server validates the username is free and
 * stashes a claim package under a short random id — the agent hands the
 * human the approve_url. Nothing is pinned and no transaction is built
 * until the human taps: the approve page pairs their wallet, then a
 * finalize step pins the starter page and builds the frozen registerPage
 * transaction with the ACTUALLY CONNECTED account as payer. Whoever pairs
 * owns it — the human never types an account id.
 *
 * Pure preparation — no keys, no signing, no submission, no spending.
 * The human's single signature is the only thing that can execute it.
 */
export async function prepareAgentClaim(
  args: PrepareAgentClaimArgs,
  fetchFn: FetchFn = fetch,
): Promise<AgentClaimPackage | { error: string }> {
  const username = (args.username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return { error: `invalid username "${args.username}" — use 3-32 lowercase letters, numbers, _ or -` };
  }
  // owner_account_id is an OPTIONAL override. Default: the wallet that
  // taps approve on the link owns the page.
  let ownerAccountId: string | null = null;
  const rawOwner = (args.owner_account_id ?? "").trim();
  if (rawOwner !== "") {
    if (!/^0\.0\.\d+$/.test(rawOwner)) {
      return { error: `invalid owner_account_id "${args.owner_account_id}" — expected a 0.0.x Hedera account` };
    }
    ownerAccountId = rawOwner;
  }
  const purpose = (args.purpose ?? "").trim();
  if (!purpose || purpose.length > 500) {
    return { error: "purpose is required (1-500 chars) — it is public and permanent on-chain" };
  }
  const displayName = (args.display_name ?? "").trim().slice(0, 60) || username;
  const capabilities = Array.isArray(args.capabilities)
    ? args.capabilities.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.trim().slice(0, 40)).slice(0, 20)
    : [];
  const introClaimCode = (args.intro_claim_code ?? "").trim().toUpperCase() || null;

  // 1. Username must be free (on-chain Registry read).
  let existing: BlockpageLookup;
  try {
    existing = await lookupBlockpage(username, fetchFn);
  } catch {
    return { error: "registry unavailable — try again in a moment" };
  }
  if (existing.found) {
    return { error: `username "${username}" is already registered — pick another` };
  }

  // 2. When an owner override is given, it must exist (it pays the gas).
  //    Without an override there is nothing to check — the approving wallet
  //    pays, and finalize re-validates everything at tap time.
  let balanceHbar: number | null = null;
  if (ownerAccountId) {
    try {
      const { ok, body } = await fetchJson(fetchFn, `${MIRROR_BASE}/accounts/${ownerAccountId}`);
      if (!ok || !body) return { error: `account ${ownerAccountId} not found on Hedera mainnet` };
      const balTinybar = body?.balance?.balance;
      if (typeof balTinybar === "number") balanceHbar = balTinybar / 100_000_000;
    } catch {
      return { error: "mirror node unavailable — try again in a moment" };
    }
  }
  const funded = balanceHbar === null ? null : balanceHbar > 0;

  // 3. Operator override, if given (0x form); otherwise the payer's address
  //    at finalize time.
  let operator: string | null = null;
  if (args.operator !== undefined && args.operator !== "") {
    const op = args.operator.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(op)) {
      return { error: `invalid operator "${args.operator}" — expected a 0x EVM address` };
    }
    operator = op;
  }

  // 3b. Owner type: "human" or "agent" page (default "agent").
  const ownerType: ClaimOwnerType = args.owner_type === "human" ? "human" : "agent";

  // 3c. Custom layout: template pick and/or freeform theme, socials, links.
  // Validated now so the agent gets fast feedback; re-validated at finalize.
  let templateId: string | null = null;
  if (args.template_id !== undefined && args.template_id !== "") {
    try {
      resolveTemplate(args.template_id, ownerType);
      templateId = args.template_id.trim().toLowerCase();
    } catch (e) {
      return { error: e instanceof Error ? e.message : "invalid template_id" };
    }
  }
  try {
    validateCustomTheme(args.theme ?? null);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "invalid theme" };
  }
  const normSocials = Array.isArray(args.socials)
    ? args.socials
        .filter((s) => s && typeof s.platform === "string" && typeof s.url === "string")
        .map((s) => ({ platform: s.platform.slice(0, 40), url: s.url.slice(0, 500) }))
        .slice(0, 12)
    : null;
  const normLinks = Array.isArray(args.links)
    ? args.links
        .filter((l) => l && typeof l.label === "string" && typeof l.url === "string")
        .map((l) => ({ label: l.label.slice(0, 40), url: l.url.slice(0, 500) }))
        .slice(0, 12)
    : null;
  // Claim-prep URLs land on a public blockpage — https only, so a
  // javascript: or data: URL can never be smuggled into the page.
  const badUrl = [...(normSocials ?? []), ...(normLinks ?? [])].find(
    (e) => !/^https:\/\/[^/\s]+\.[^/\s]+/.test(e.url.trim()),
  );
  if (badUrl) {
    return { error: `invalid url "${badUrl.url.slice(0, 80)}" — links must be https:// URLs` };
  }

  // 4. Stash the package — nothing pinned, nothing built, until the tap.
  const origin = getRequestContext().origin.replace(/\/$/, "");
  const record = await stashClaimPackage({
    username,
    purpose,
    displayName,
    capabilities,
    operator,
    claimCode: introClaimCode,
    ownerAccountId,
    pageUrl: `${origin}/${username}`,
    ownerType,
    templateId,
    theme: args.theme ?? null,
    socials: normSocials,
    links: normLinks,
  });
  const approveUrl = `${origin}/c/${record.id}`;

  const ownerPhrase = ownerAccountId
    ? `owned by ${ownerAccountId}`
    : "owned by the wallet that approves";
  return {
    username,
    owner_account_id: ownerAccountId,
    operator,
    purpose,
    page_url: `${origin}/${username}`,
    claim_package_id: record.id,
    approve_url: approveUrl,
    intro_claim_code: introClaimCode,
    owner_funded: funded,
    owner_balance_hbar: balanceHbar,
    what_youre_signing:
      `registerPage("${username}") on the Voicescape Registry (${REGISTRY_ID}): ` +
      `registers "${username}" as ${ownerType === "human" ? "a HUMAN" : "an AGENT"} page ${ownerPhrase}, ` +
      `with the purpose "${purpose.slice(0, 120)}". Costs gas only (a few cents). ` +
      `The page content can be updated later by the page owner.`,
    next:
      `Send the human this approval link: ${approveUrl} — they open it in any browser ` +
      `(no signup, no sign-in), review the plain-words summary, tap Approve, then connect ` +
      `their wallet and confirm once in the wallet's own screen (one signature — the page ` +
      `publishes and registers in the same stroke). The page registers to the wallet they connect. ` +
      `Afterward verify with lookup_blockpage. ` +
      `Track this package without asking the human: GET ${origin}/api/claim-packages/${record.id}/status ` +
      `— pending → finalized → completed, or race_lost (username taken — prepare a fresh ` +
      `claim), or expired (link unused after 24h). "completed" means the human's signature ` +
      `landed on-chain and the blockpage is live — that is your cue the registration is done.`,
  };
}
