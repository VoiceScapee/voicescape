/**
 * Voicescape MCP server — tool implementations (v1).
 *
 * Two tiers:
 *  - PUBLIC tools (no auth): read-only mirror-node reads any agent on the
 *    internet may call. They describe exactly what they check — no
 *    present-tense claims beyond the data returned.
 *  - OPERATOR tools (Brandon's private tier): require
 *    `Authorization: Bearer <MCP_OPERATOR_TOKEN>` (constant-time check).
 *    They only ever PREPARE unsigned signing packages — pure functions,
 *    no network, no signing, no submission. The server never holds keys.
 *
 * All mirror-node access goes through injectable `fetchFn` so tests drive
 * these with fixtures instead of the live network. Production passes the
 * global fetch.
 *
 * Security notes:
 *  - The operator token is NEVER logged. Nothing in this module prints
 *    headers, tokens, or the env var.
 *  - Auth state travels per-request via AsyncLocalStorage (set by the
 *    route handler from the raw Request — the MCP transport does not
 *    forward HTTP headers to tool handlers).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";
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

export const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";
export const REGISTRY_ID = "0.0.10854058";
export const TREASURY_ID = "0.0.10424063";
/** Registry EVM address (same constant as app/api/resolve/route.ts). */
export const REGISTRY_EVM = "0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58";

const FETCH_TIMEOUT_MS = 10_000;
const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
const ACCOUNT_RE = /^0\.0\.\d{1,19}$/;
const CONTRACT_RE = /^0\.0\.\d{1,19}$/;
const FN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

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
  operatorAuthed: boolean;
  /** Origin of the incoming request — used for same-app self-fetch. */
  origin: string;
  /** Best-effort client IP (see lib/server/rate-limit.ts trust order). */
  clientIp: string;
}

export const requestContextStorage = new AsyncLocalStorage<McpRequestContext>();

const DEFAULT_CONTEXT: McpRequestContext = {
  operatorAuthed: false,
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
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Wrap a plain object as an MCP text result (JSON, pretty-printed). */
export function toolResult(obj: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

/** Wrap a plain error message as an MCP error result. Never throws. */
export function toolError(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

/* ------------------------------------------------------------------ */
/* Operator auth (constant-time, never logged)                          */
/* ------------------------------------------------------------------ */

/**
 * True only when the request carries `Authorization: Bearer <token>` and
 * the token matches MCP_OPERATOR_TOKEN in constant time. False when the
 * env var is unset, the header is missing, or the scheme is wrong.
 * The token value is never logged or included in any output.
 */
export function checkOperatorAuth(headers: Headers): boolean {
  const expected = process.env.MCP_OPERATOR_TOKEN;
  if (!expected) return false;
  const auth = headers.get("authorization");
  if (!auth) return false;
  const m = /^Bearer (.+)$/.exec(auth.trim());
  if (!m) return false;
  const a = createHash("sha256").update(m[1], "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Gate for operator tools: returns an error result when not authed. */
export function requireOperator(): McpToolResult | null {
  if (!getRequestContext().operatorAuthed) {
    return toolError(
      "operator tool: missing or invalid Authorization Bearer token. " +
        "Set MCP_OPERATOR_TOKEN on the server and call with header " +
        "'Authorization: Bearer <token>'.",
    );
  }
  return null;
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
/* OPERATOR tool 7: prepare_tip (pure — no network, no signing)         */
/* ------------------------------------------------------------------ */

export interface TipPackage {
  type: "prepare_tip";
  unsigned: true;
  recipient_account: string;
  amount_hbar: string;
  amount_tinybar: string;
  memo: string;
  route: {
    contract: string;
    function: string;
    settlement: string;
  };
  notice: string;
}

const UNSIGNED_NOTICE =
  "Unsigned. Requires Brandon's HashPack signature — the server never signs or submits this transaction.";

/** HBAR decimal string -> exact tinybar string. Throws on bad input. */
function hbarToTinybarString(amount: string): string {
  const t = amount.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t)) {
    throw new Error("amount must be a positive number with at most 8 decimal places");
  }
  const [whole, frac = ""] = t.split(".");
  const tinybar = BigInt(whole) * 100_000_000n + BigInt((frac + "00000000").slice(0, 8));
  if (tinybar <= 0n) throw new Error("amount must be greater than 0");
  return tinybar.toString();
}

/**
 * Build an unsigned tip signing package. Pure function: no network, no
 * keys, no signing, no submission. Validates the account id and amount.
 */
export function prepareTip(args: {
  recipient_account: string;
  amount_hbar: string | number;
  memo?: string;
}): TipPackage | { error: string } {
  const recipient = String(args.recipient_account ?? "").trim();
  if (!ACCOUNT_RE.test(recipient)) {
    return { error: "recipient_account must look like 0.0.12345" };
  }
  let tinybar: string;
  try {
    tinybar = hbarToTinybarString(String(args.amount_hbar ?? ""));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "invalid amount" };
  }
  const memo = args.memo === undefined || args.memo === null ? "" : String(args.memo);
  if (memo.length > 100) {
    return { error: "memo must be 100 characters or fewer" };
  }
  const amountHbar = tinybarToHbar(BigInt(tinybar));
  return {
    type: "prepare_tip",
    unsigned: true,
    recipient_account: recipient,
    amount_hbar: amountHbar,
    amount_tinybar: tinybar,
    memo,
    route: {
      contract: TIPS_CONTRACT_ID,
      function: "tipPage(string) payable",
      settlement:
        `atomic on-chain 98/2 split: 98% to the recipient's wallet, 2% to treasury ${TREASURY_ID}. ` +
        "The Tips contract retains no balance.",
    },
    notice: UNSIGNED_NOTICE,
  };
}

/* ------------------------------------------------------------------ */
/* OPERATOR tool 8: prepare_contract_call (pure — never executes)       */
/* ------------------------------------------------------------------ */

export interface ContractCallPackage {
  type: "prepare_contract_call";
  unsigned: true;
  contract_id: string;
  function_name: string;
  params: unknown;
  notice: string;
}

/**
 * Build an unsigned contract-call package. Pure function: it validates
 * the inputs and returns the exact call description — it never encodes
 * beyond display, never signs, never submits.
 */
export function prepareContractCall(args: {
  contract_id: string;
  function_name: string;
  params_json: string;
}): ContractCallPackage | { error: string } {
  const contractId = String(args.contract_id ?? "").trim();
  if (!CONTRACT_RE.test(contractId)) {
    return { error: "contract_id must look like 0.0.12345" };
  }
  const fnName = String(args.function_name ?? "").trim();
  if (!FN_NAME_RE.test(fnName)) {
    return { error: "function_name must be a plain Solidity function name" };
  }
  let params: unknown;
  try {
    params = JSON.parse(String(args.params_json ?? ""));
  } catch {
    return { error: "params_json must be valid JSON" };
  }
  if (params === null || typeof params !== "object") {
    return { error: "params_json must be a JSON array or object" };
  }
  return {
    type: "prepare_contract_call",
    unsigned: true,
    contract_id: contractId,
    function_name: fnName,
    params,
    notice:
      UNSIGNED_NOTICE +
      " Review the contract, function, and parameters carefully before signing.",
  };
}
