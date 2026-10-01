/**
 * Agent webhooks — push delivery for tips and marketplace purchases.
 *
 * Any Voicescape page owner (human or agent) registers an HTTPS endpoint;
 * the `/api/webhooks/poll` cron tails the Tips contract's event logs on the
 * Hedera mainnet mirror node and POSTs matching events to each subscribed
 * URL, signed with the subscription's secret (HMAC-SHA256).
 *
 * Design notes:
 * - Storage is the shared KV store (`webhook:sub:<id>`, index
 *   `webhook:subs:<owner>`). The store mandates a TTL, so durable state
 *   uses a 10-year TTL — that is this store's "durable" pattern.
 * - Owner identity is the canonical 0x address from the verified session
 *   (NOT 0.0.x: ECDSA wallets have alias-form EVM addresses with no
 *   long-zero 0.0.x equivalent — see lib/session-message.ts).
 * - Event topics are matched against the Tips contract event ABIs; the
 *   recipient wallet comes from the log topics, so matching needs no
 *   per-wallet mirror-node queries.
 * - The cursor is an exact consensus-timestamp STRING. Never parseFloat it:
 *   float rounding re-fetches the same trailing page forever.
 * - No testnet code paths. Mainnet only.
 */

import { randomBytes, randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { ethers } from "ethers";
import { getKvStore, type KvStore } from "./store";
import { defaultAuthPort, type VerifyResult } from "./townhall/auth";
import { resolveUsernameForOwner } from "@/lib/registry-reverse";
import { mirrorBaseUrl } from "./townhall/topics";
import { getTipsAddress } from "@/lib/contracts";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type WebhookEventKind = "tip" | "purchase";

export interface WebhookSubscription {
  id: string;
  /** Normalized https URL. */
  url: string;
  events: WebhookEventKind[];
  /** Canonical 0x owner address (lowercase), from the verified session. */
  owner: string;
  /** Per-subscription HMAC secret, 32 random bytes as hex. Never exposed. */
  secret: string;
  createdAt: string;
}

/** Public shape: no secret. */
export interface PublicSubscription {
  id: string;
  url: string;
  events: WebhookEventKind[];
  createdAt: string;
}

export interface WebhookEvent {
  event: WebhookEventKind;
  /** 0.0.x@seconds.nanos when resolvable, else the transaction hash. */
  txId: string;
  /** Payer EVM address (0x…). */
  from: string;
  /** Recipient EVM address (0x…) — the subscribed page owner's wallet. */
  to: string;
  /** Whole-HBAR amount in tinybar, as a decimal string (never a float). */
  amountTinybar: string;
  /** Consensus timestamp string, exactly as the mirror node returned it. */
  timestamp: string;
}

export interface WebhookDeps {
  store: KvStore;
  verifySession: (cred: unknown) => Promise<VerifyResult>;
  /** Wallet address → registered page username, or null when none. */
  resolvePageOwner: (address: string) => Promise<string | null>;
  /** Mirror-node base URL (injectable for tests). */
  mirrorBase: () => string;
  /** Tips contract id (injectable for tests). */
  tipsContract: () => string | undefined;
  /** Host → resolved IP strings (injectable; default does a real DNS lookup). */
  resolveHost?: (host: string) => Promise<string[]>;
  nowMs?: () => number;
}

export function defaultWebhookDeps(): WebhookDeps {
  return {
    store: getKvStore(),
    verifySession: (cred: unknown) => defaultAuthPort().verifySession(cred),
    resolvePageOwner: (address: string) => resolveUsernameForOwner(address),
    mirrorBase: () => mirrorBaseUrl(),
    tipsContract: () => getTipsAddress() ?? undefined,
    resolveHost: async (host: string) => {
      const all = await dnsLookup(host, { all: true });
      return all.map((r) => r.address);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const SUB_KEY = (id: string) => `webhook:sub:${id}`;
const SUBS_INDEX = (owner: string) => `webhook:subs:${owner.toLowerCase()}`;
const CURSOR_KEY = "webhook:cursor";
const DELIVERED_KEY = (txHash: string, subId: string) => `webhook:delivered:${txHash}:${subId}`;

/** 10 years in ms — the store's mandatory-TTL "durable" pattern. */
const DURABLE_TTL_MS = 10 * 365 * 24 * 3600 * 1000;
const DELIVERED_TTL_MS = 24 * 3600 * 1000;
const MAX_SUBS_PER_OWNER = 10;
const MAX_URL_LEN = 2048;
const DISPATCH_TIMEOUT_MS = 5000;
const MAX_LOGS_PER_RUN = 100;

const TIPS_IFACE = new ethers.Interface([
  "event TipSent(string indexed username, address indexed from, address indexed toOwner, uint256 amount, uint256 fee)",
]);
const SALE_IFACE = new ethers.Interface([
  "event PurchaseCompleted(address indexed buyer, address indexed seller, string listingRef, uint256 amount, uint256 fee)",
]);

export const TIPSENT_TOPIC = TIPS_IFACE.getEvent("TipSent")!.topicHash.toLowerCase();
export const PURCHASE_TOPIC = SALE_IFACE.getEvent("PurchaseCompleted")!.topicHash.toLowerCase();

/* ------------------------------------------------------------------ */
/* URL validation (SSRF guard)                                         */
/* ------------------------------------------------------------------ */

function v4Private(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 10 || // 10/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    a === 127 || // 127/8 loopback
    (a === 169 && b === 254) || // 169.254/16 link-local (cloud metadata)
    a === 0 || // 0/8
    (a === 192 && b === 0 && p[2] === 2) || // TEST-NET-1
    (a === 198 && b === 51 && p[2] === 100) || // TEST-NET-2
    (a === 203 && b === 0 && p[2] === 113) || // TEST-NET-3
    a >= 224 // 224/4 multicast + 240/4 reserved
  );
}

function v6Private(ip: string): boolean {
  const l = ip.toLowerCase();
  return (
    l === "::1" || // loopback
    l === "::" || // unspecified
    l.startsWith("fe80:") || // link-local
    l.startsWith("fc") || // unique-local fc00::/7
    l.startsWith("fd") || // unique-local fd00::/8
    l.startsWith("ff") // multicast
  );
}

/** True when an IP literal is safe to send webhook traffic to. */
export function ipAllowed(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return !v4Private(ip);
  if (fam === 6) return !v6Private(ip);
  return false;
}

const BAD_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".invalid", ".test"];

/** Reject obviously-unsafe hostnames without a DNS lookup. */
export function hostnameAllowed(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (!h) return false;
  if (h === "localhost") return false;
  if (BAD_SUFFIXES.some((s) => h.endsWith(s))) return false;
  const fam = isIP(h);
  if (fam !== 0) return ipAllowed(h);
  // Plain DNS name — resolved and re-checked at dispatch time.
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(h);
}

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/**
 * Validate a webhook URL at subscribe time: https only, no credentials,
 * no non-443 port, no private/loopback target. DNS is resolved and
 * re-checked at dispatch time (TOCTOU guard).
 */
export function validateWebhookUrl(raw: unknown): UrlCheck {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "url is required" };
  if (raw.length > MAX_URL_LEN) return { ok: false, error: "url is too long" };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: "url is not a valid URL" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "url must use https" };
  if (u.username || u.password) return { ok: false, error: "url must not contain credentials" };
  if (u.port && u.port !== "443") return { ok: false, error: "url must not specify a non-443 port" };
  if (!hostnameAllowed(u.hostname)) {
    return { ok: false, error: "url hostname is not allowed (private, loopback, or invalid)" };
  }
  return { ok: true, url: u.toString() };
}

/* ------------------------------------------------------------------ */
/* HMAC signing                                                        */
/* ------------------------------------------------------------------ */

/** HMAC-SHA256 of the raw body, hex. */
export function signDelivery(secretHex: string, rawBody: string): string {
  return createHmac("sha256", Buffer.from(secretHex, "hex")).update(rawBody, "utf8").digest("hex");
}

/** Constant-time verification of an `x-vs-signature` header value. */
export function verifyDeliverySignature(secretHex: string, rawBody: string, signature: string): boolean {
  if (typeof signature !== "string" || !/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  const expected = signDelivery(secretHex, rawBody);
  const a = Buffer.from(signature.toLowerCase(), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

function toPublic(sub: WebhookSubscription): PublicSubscription {
  return { id: sub.id, url: sub.url, events: sub.events, createdAt: sub.createdAt };
}

async function readIndex(store: KvStore, owner: string): Promise<string[]> {
  const raw = await store.get(SUBS_INDEX(owner));
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function writeIndex(store: KvStore, owner: string, ids: string[]): Promise<void> {
  await store.set(SUBS_INDEX(owner), JSON.stringify(ids), DURABLE_TTL_MS);
}

export type CreateResult =
  | { ok: true; subscription: PublicSubscription; secret: string }
  | { ok: false; error: string; status: 400 | 403 | 409 | 503 };

export function normalizeEvents(raw: unknown): WebhookEventKind[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: WebhookEventKind[] = [];
  for (const e of raw) {
    if (e !== "tip" && e !== "purchase") return null;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

export async function createSubscription(
  deps: WebhookDeps,
  owner: string,
  urlRaw: unknown,
  eventsRaw: unknown,
): Promise<CreateResult> {
  const urlCheck = validateWebhookUrl(urlRaw);
  if (!urlCheck.ok) return { ok: false, error: urlCheck.error, status: 400 };
  const events = normalizeEvents(eventsRaw);
  if (!events) return { ok: false, error: "events must be a non-empty array of \"tip\" and/or \"purchase\"" , status: 400 };

  const ids = await readIndex(deps.store, owner);
  if (ids.length >= MAX_SUBS_PER_OWNER) {
    return { ok: false, error: `subscription limit reached (${MAX_SUBS_PER_OWNER} per wallet)`, status: 409 };
  }

  const sub: WebhookSubscription = {
    id: randomUUID(),
    url: urlCheck.url,
    events,
    owner: owner.toLowerCase(),
    secret: randomBytes(32).toString("hex"),
    createdAt: new Date(deps.nowMs ? deps.nowMs() : Date.now()).toISOString(),
  };
  try {
    await deps.store.set(SUB_KEY(sub.id), JSON.stringify(sub), DURABLE_TTL_MS);
    await writeIndex(deps.store, owner, [...ids, sub.id]);
  } catch (e) {
    return { ok: false, error: "subscription store unavailable — try again", status: 503 };
  }
  return { ok: true, subscription: toPublic(sub), secret: sub.secret };
}

export async function listSubscriptions(deps: WebhookDeps, owner: string): Promise<PublicSubscription[]> {
  const ids = await readIndex(deps.store, owner);
  const out: PublicSubscription[] = [];
  for (const id of ids) {
    const raw = await deps.store.get(SUB_KEY(id));
    if (!raw) continue;
    try {
      const sub = JSON.parse(raw) as WebhookSubscription;
      if (sub.owner === owner.toLowerCase()) out.push(toPublic(sub));
    } catch {
      /* corrupt entry — skip */
    }
  }
  return out;
}

export async function deleteSubscription(
  deps: WebhookDeps,
  owner: string,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string; status: 404 | 503 }> {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return { ok: false, error: "unknown subscription", status: 404 };
  const raw = await deps.store.get(SUB_KEY(id));
  if (!raw) return { ok: false, error: "unknown subscription", status: 404 };
  let sub: WebhookSubscription;
  try {
    sub = JSON.parse(raw) as WebhookSubscription;
  } catch {
    return { ok: false, error: "unknown subscription", status: 404 };
  }
  if (sub.owner !== owner.toLowerCase()) return { ok: false, error: "unknown subscription", status: 404 };
  try {
    await deps.store.del(SUB_KEY(id));
    await writeIndex(deps.store, owner, (await readIndex(deps.store, owner)).filter((x) => x !== id));
  } catch {
    return { ok: false, error: "subscription store unavailable — try again", status: 503 };
  }
  return { ok: true };
}

/** Full subscription records (with secrets) for dispatch. */
export async function subscriptionsForWallet(store: KvStore, wallet: string): Promise<WebhookSubscription[]> {
  const ids = await readIndex(store, wallet);
  const out: WebhookSubscription[] = [];
  for (const id of ids) {
    const raw = await store.get(SUB_KEY(id));
    if (!raw) continue;
    try {
      const sub = JSON.parse(raw) as WebhookSubscription;
      if (sub.owner === wallet.toLowerCase() && typeof sub.secret === "string") out.push(sub);
    } catch {
      /* skip */
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Event decoding                                                      */
/* ------------------------------------------------------------------ */

interface MirrorLog {
  topics?: string[];
  data?: string;
  timestamp?: string;
  transaction_hash?: string;
}

function topicAddress(topic: string | undefined): string | null {
  if (typeof topic !== "string" || topic.length < 42) return null;
  return ("0x" + topic.slice(-40)).toLowerCase();
}

/** Decode one contract log into a WebhookEvent, or null when not ours. */
export function decodeLog(log: MirrorLog): WebhookEvent | null {
  const topic0 = log.topics?.[0]?.toLowerCase();
  const ts = log.timestamp;
  const txHash = log.transaction_hash;
  if (!topic0 || typeof ts !== "string" || typeof txHash !== "string") return null;
  try {
    if (topic0 === TIPSENT_TOPIC) {
      const parsed = TIPS_IFACE.decodeEventLog("TipSent", log.data ?? "0x", log.topics ?? []);
      const from = topicAddress(log.topics?.[2]);
      const to = topicAddress(log.topics?.[3]);
      if (!from || !to) return null;
      return {
        event: "tip",
        txId: txHash,
        from,
        to,
        amountTinybar: BigInt(parsed.amount.toString()).toString(),
        timestamp: ts,
      };
    }
    if (topic0 === PURCHASE_TOPIC) {
      const parsed = SALE_IFACE.decodeEventLog("PurchaseCompleted", log.data ?? "0x", log.topics ?? []);
      const from = topicAddress(log.topics?.[1]);
      const to = topicAddress(log.topics?.[2]);
      if (!from || !to) return null;
      return {
        event: "purchase",
        txId: txHash,
        from,
        to,
        amountTinybar: BigInt(parsed.amount.toString()).toString(),
        timestamp: ts,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Max of two mirror-node consensus timestamps, compared as exact strings
 * via BigInt parts — never parseFloat (float rounding re-fetches forever).
 */
export function maxTimestamp(a: string, b: string): string {
  const [as = "", an = ""] = a.split(".");
  const [bs = "", bn = ""] = b.split(".");
  const secA = BigInt(as || "0");
  const secB = BigInt(bs || "0");
  if (secA !== secB) return secA > secB ? a : b;
  const nanoA = BigInt((an || "").padEnd(9, "0") || "0");
  const nanoB = BigInt((bn || "").padEnd(9, "0") || "0");
  return nanoA >= nanoB ? a : b;
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

export interface DispatchOutcome {
  delivered: number;
  failed: number;
  skippedDedupe: number;
}

/**
 * POST one event to one subscription: DNS re-check at send time (SSRF
 * TOCTOU guard), 5s timeout, one immediate retry, HMAC-signed body.
 * Delivery failures are logged, never thrown. Dedupe via setNx.
 */
export async function dispatchToSubscription(
  deps: WebhookDeps,
  sub: WebhookSubscription,
  event: WebhookEvent,
): Promise<"delivered" | "failed" | "skippedDedupe"> {
  const dedupeKey = DELIVERED_KEY(event.txId, sub.id);
  let claimed = false;
  try {
    claimed = await deps.store.setNx(dedupeKey, "1", DELIVERED_TTL_MS);
  } catch (e) {
    console.error(`[webhooks] dedupe store error: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
  if (!claimed) return "skippedDedupe";

  // Re-validate the hostname at dispatch time: resolve and check every IP.
  let host: string;
  try {
    host = new URL(sub.url).hostname;
  } catch {
    return "failed";
  }
  try {
    const ips = deps.resolveHost
      ? await deps.resolveHost(host)
      : await (async () => {
          const all = await dnsLookup(host, { all: true });
          return all.map((r) => r.address);
        })();
    if (!ips.length || !ips.every(ipAllowed)) {
      console.error(`[webhooks] dispatch blocked: ${host} resolves to a disallowed address`);
      return "failed";
    }
  } catch (e) {
    console.error(`[webhooks] DNS check failed for ${host}: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }

  const body = JSON.stringify(event);
  const deliveryId = randomUUID();
  const headers = {
    "content-type": "application/json",
    "x-vs-signature": signDelivery(sub.secret, body),
    "x-vs-delivery": deliveryId,
    "user-agent": "Voicescape-Webhooks/1.0",
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(sub.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      });
      // Drain the body so the socket can be reused; ignore content.
      await res.arrayBuffer().catch(() => null);
      if (res.ok) return "delivered";
      console.error(`[webhooks] delivery ${deliveryId} → ${sub.url} answered ${res.status}`);
    } catch (e) {
      console.error(`[webhooks] delivery ${deliveryId} → ${sub.url} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return "failed";
}

/* ------------------------------------------------------------------ */
/* Poll: tail the Tips contract and dispatch                            */
/* ------------------------------------------------------------------ */

export interface PollResult {
  ok: true;
  seeded?: boolean;
  logsSeen: number;
  events: number;
  delivered: number;
  failed: number;
  skippedDedupe: number;
  cursor: string | null;
}

async function resolveTxId(mirrorBase: string, timestamp: string, txHash: string): Promise<string> {
  try {
    const res = await fetch(
      `${mirrorBase}/api/v1/transactions?${new URLSearchParams({ timestamp })}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS) },
    );
    if (!res.ok) return txHash;
    const data = (await res.json()) as { transactions?: { transaction_id?: string }[] };
    const id = data.transactions?.[0]?.transaction_id;
    return typeof id === "string" && id ? id : txHash;
  } catch {
    return txHash;
  }
}

/**
 * Tail the Tips contract logs since the stored cursor and dispatch new
 * tip/purchase events to matching subscriptions. Cursor is the exact
 * consensus-timestamp string of the newest log seen (or the seed on first
 * run). Never throws on delivery failures; throws only when the mirror
 * node itself is unreachable (caller maps to 502 so the next cron retries
 * with the cursor unadvanced).
 */
export async function pollAndDispatch(deps: WebhookDeps): Promise<PollResult> {
  const store = deps.store;
  const tips = deps.tipsContract();
  if (!tips) throw new Error("tips contract address unavailable");

  let cursor = await store.get(CURSOR_KEY);
  if (!cursor) {
    const now = deps.nowMs ? deps.nowMs() : Date.now();
    cursor = `${Math.floor(now / 1000)}.000000000`;
    await store.set(CURSOR_KEY, cursor, DURABLE_TTL_MS);
    return { ok: true, seeded: true, logsSeen: 0, events: 0, delivered: 0, failed: 0, skippedDedupe: 0, cursor };
  }

  const url =
    `${deps.mirrorBase()}/api/v1/contracts/${tips}/results/logs?` +
    new URLSearchParams({ order: "asc", limit: String(MAX_LOGS_PER_RUN), timestamp: `gt:${cursor}` });
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`mirror node ${res.status}`);
  const data = (await res.json()) as { logs?: MirrorLog[] };
  const logs = Array.isArray(data.logs) ? data.logs : [];

  let newest = cursor;
  const outcome: DispatchOutcome = { delivered: 0, failed: 0, skippedDedupe: 0 };
  let events = 0;

  for (const log of logs.slice(0, MAX_LOGS_PER_RUN)) {
    if (typeof log.timestamp === "string") newest = maxTimestamp(newest, log.timestamp);
    const event = decodeLog(log);
    if (!event) continue;
    events++;
    // Resolve the canonical tx id (best-effort; falls back to the hash).
    event.txId = await resolveTxId(deps.mirrorBase(), event.timestamp, event.txId);
    const subs = await subscriptionsForWallet(store, event.to);
    for (const sub of subs) {
      if (!sub.events.includes(event.event)) continue;
      const r = await dispatchToSubscription(deps, sub, event);
      outcome[r === "delivered" ? "delivered" : r === "failed" ? "failed" : "skippedDedupe"]++;
    }
  }

  await store.set(CURSOR_KEY, newest, DURABLE_TTL_MS);
  return { ok: true, logsSeen: logs.length, events, ...outcome, cursor: newest };
}
