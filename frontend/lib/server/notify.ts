/**
 * Voicescape — human return-loop notifications (Slice 2).
 *
 * Server-side event detectors for the things that should pull a human
 * back to the dapp: replies to your forum posts, @mentions in forum/chat,
 * new followers, and marketplace sales where you are the seller.
 *
 * Design notes:
 * - READ-ONLY with respect to value: nothing here moves HBAR, touches the
 *   payment/wallet/fee/contract code paths, or submits anything on-chain.
 *   All chain reads go through the official Hedera mirror-node REST API
 *   (HCS topics for forum/chat, contract logs for marketplace sales).
 * - Two delivery surfaces share one detection core:
 *   1. POST /api/notify/check — the cron path. Runs detection AND sends
 *      web-push to opted-in devices (same KV subscription model as the
 *      tip push in ./push.ts).
 *   2. Read-path backfill (maybeBackfillSocial) — GET /api/notifications
 *      and GET /api/digest run detection WITHOUT push when the last run
 *      is stale, so the bell and digest populate even before any cron is
 *      wired. Push stays on the cron path only.
 * - Detected events land in a per-wallet KV inbox (`notif:inbox:<addr>`,
 *   capped, 30-day TTL) that the bell and digest read. No server-side
 *   visit tracking: the "while you were away" watermark lives in the
 *   client's localStorage.
 * - Push stays opt-in: delivery only goes to subscriptions created through
 *   the existing /api/push/subscriptions consent flow.
 * - Public copy never discloses internal details (wallet addresses are
 *   shown shortened, no treasury/revenue figures anywhere).
 */

import type { HcsPort } from "./townhall/hcs";
import type { RegistryPort } from "./townhall/registry-check";
import { getTopicId } from "./townhall/topics";
import type { ChatMessage, PostMessage, StoredMessage } from "./townhall/types";
import type { KvStore } from "./store";
import type { DigestItem, SocialNotif, SocialNotifType } from "@/lib/notify-types";
import {
  PUSH_SENT_TTL_MS,
  VAPID_SUBJECT,
  ensureVapidKeypair,
  isGoneError,
  listSubscriptions,
  removeSubscription,
  secretsMatch,
  webPushSender,
  type PushPayload,
  type PushSender,
} from "./push";
import { resolveUsernameForOwner } from "@/lib/registry-reverse";

/* ------------------------------------------------------------------ */
/* Types (shared shapes live in lib/notify-types.ts — client-safe)     */
/* ------------------------------------------------------------------ */

export type { DigestItem, NotifType, SocialNotif, SocialNotifType } from "@/lib/notify-types";

/* ------------------------------------------------------------------ */
/* KV layout                                                           */
/* ------------------------------------------------------------------ */

export const NOTIF_LAST_RUN_KV_KEY = "notif:sweep:lastRun";
export const NOTIF_FORUM_SEQ_KV_KEY = "notif:sweep:forumSeq";
export const NOTIF_CHAT_SEQ_KV_KEY = "notif:sweep:chatSeq";
export const NOTIF_PURCHASE_TS_KV_KEY = "notif:sweep:purchaseTs";
export const NOTIF_FOLLOW_EVENTS_KV_KEY = "notif:follow-events";
export const NOTIF_FOLLOW_EVENTS_IDX_KV_KEY = "notif:follow-events:idx";
/** Per-wallet inbox of recent social events (JSON array, capped). */
export const NOTIF_INBOX_PREFIX = "notif:inbox:";
/** Idempotency: one key per detected event, setNx-claimed. */
export const NOTIF_SENT_PREFIX = "notif:sent:";
/** seq → author username cache for reply parent resolution. */
export const NOTIF_AUTHOR_PREFIX = "notif:author:forum:";

export const NOTIF_INBOX_TTL_MS = 30 * 24 * 3600 * 1000;
export const NOTIF_INBOX_CAP = 50;
export const NOTIF_AUTHOR_TTL_MS = 30 * 24 * 3600 * 1000;
export const NOTIF_FOLLOW_EVENTS_TTL_MS = 30 * 24 * 3600 * 1000;
export const NOTIF_FOLLOW_EVENTS_CAP = 500;
/** Max HCS messages scanned per topic per sweep — bounds mirror-node cost. */
export const NOTIF_SWEEP_MSG_CAP = 500;
/** Read-path backfill runs at most this often (ms). */
export const NOTIF_BACKFILL_MIN_INTERVAL_MS = 180_000;

const DAY_MS = 24 * 3600 * 1000;

/* ------------------------------------------------------------------ */
/* Address forms + inbox                                               */
/* ------------------------------------------------------------------ */

/**
 * All lowercase address forms for a wallet ("0.0.x" and long-zero "0x…").
 * The inbox is written/read under every form so a notification addressed
 * to either shape is found.
 */
export function addressForms(address: string): string[] {
  const raw = address.trim().toLowerCase();
  const forms = new Set<string>([raw]);
  const hedera = /^0\.0\.(\d+)$/.exec(raw);
  if (hedera) {
    try {
      forms.add("0x" + BigInt(hedera[1]).toString(16).padStart(40, "0"));
    } catch {
      /* ignore */
    }
  }
  const longZero = /^0x0{24}([0-9a-f]{16})$/.exec(raw);
  if (longZero) {
    try {
      forms.add("0.0." + BigInt("0x" + longZero[1]).toString(10));
    } catch {
      /* ignore */
    }
  }
  return [...forms];
}

function inboxKeysForAddress(address: string): string[] {
  return addressForms(address).map((f) => `${NOTIF_INBOX_PREFIX}${f}`);
}

function parseNotifArray(raw: string | null): SocialNotif[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: SocialNotif[] = [];
    for (const n of v) {
      if (
        n &&
        typeof n === "object" &&
        typeof (n as { id?: unknown }).id === "string" &&
        typeof (n as { type?: unknown }).type === "string" &&
        typeof (n as { tsMs?: unknown }).tsMs === "number" &&
        Number.isFinite((n as { tsMs: number }).tsMs)
      ) {
        const r = n as SocialNotif;
        out.push({
          id: r.id,
          type: r.type,
          tsMs: r.tsMs,
          actor: typeof r.actor === "string" ? r.actor : "someone",
          title: typeof r.title === "string" ? r.title : "",
          body: typeof r.body === "string" ? r.body : "",
          url: typeof r.url === "string" ? r.url : "/",
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** All inbox items for a wallet across every address form, newest first. */
export async function readInbox(kv: KvStore, address: string): Promise<SocialNotif[]> {
  const seen = new Map<string, SocialNotif>();
  for (const key of inboxKeysForAddress(address)) {
    for (const n of parseNotifArray(await kv.get(key))) {
      if (!seen.has(n.id)) seen.set(n.id, n);
    }
  }
  return [...seen.values()].sort((a, b) => b.tsMs - a.tsMs);
}

/**
 * Append one event to a wallet's inbox (all address forms), newest first,
 * capped at NOTIF_INBOX_CAP. Idempotent on the event id.
 */
export async function appendInbox(
  kv: KvStore,
  wallet: string,
  notif: SocialNotif,
): Promise<void> {
  for (const key of inboxKeysForAddress(wallet)) {
    const current = parseNotifArray(await kv.get(key)).filter((n) => n.id !== notif.id);
    const next = [notif, ...current].slice(0, NOTIF_INBOX_CAP);
    await kv.set(key, JSON.stringify(next), NOTIF_INBOX_TTL_MS);
  }
}

/* ------------------------------------------------------------------ */
/* Follow events (written by the follows route, drained by the sweep)  */
/* ------------------------------------------------------------------ */

export interface FollowEvent {
  id: string;
  /** Follower wallet, lowercase. */
  followerWallet: string;
  /** Followed page username, lowercase. */
  username: string;
  tsMs: number;
}

function parseFollowEvents(raw: string | null): FollowEvent[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is FollowEvent =>
        !!e &&
        typeof e === "object" &&
        typeof (e as { id?: unknown }).id === "string" &&
        typeof (e as { followerWallet?: unknown }).followerWallet === "string" &&
        typeof (e as { username?: unknown }).username === "string" &&
        typeof (e as { tsMs?: unknown }).tsMs === "number",
    );
  } catch {
    return [];
  }
}

/**
 * Record a NEW follow (call only for first-time follows — the route checks
 * the follow list before calling). Fail-soft: never throws.
 */
export async function recordFollowEvent(
  kv: KvStore,
  followerWallet: string,
  username: string,
): Promise<void> {
  try {
    const wallet = followerWallet.trim().toLowerCase();
    const name = username.trim().toLowerCase();
    if (!wallet || !name) return;
    const events = parseFollowEvents(await kv.get(NOTIF_FOLLOW_EVENTS_KV_KEY));
    const id = `follow:${name}:${wallet}`;
    if (events.some((e) => e.id === id)) return;
    events.push({ id, followerWallet: wallet, username: name, tsMs: Date.now() });
    await kv.set(
      NOTIF_FOLLOW_EVENTS_KV_KEY,
      JSON.stringify(events.slice(-NOTIF_FOLLOW_EVENTS_CAP)),
      NOTIF_FOLLOW_EVENTS_TTL_MS,
    );
  } catch {
    /* follow-event logging must never break the follow itself */
  }
}

/* ------------------------------------------------------------------ */
/* Mention parsing                                                     */
/* ------------------------------------------------------------------ */

const MENTION_RE = /(^|[\s>"'(@])@([a-z0-9_-]{3,32})/g;

/**
 * Usernames @mentioned in a body of text. Lowercase, deduped, in order of
 * appearance. Skips email-like matches via the preceding-char guard.
 */
export function extractMentions(body: string): string[] {
  const out: string[] = [];
  if (typeof body !== "string") return out;
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(body)) !== null) {
    const name = m[2].toLowerCase();
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Short display snippet of a message body for notification text. */
export function snippet(body: string, max = 140): string {
  const flat = (typeof body === "string" ? body : "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export function shortWallet(wallet: string): string {
  const w = wallet.trim();
  return w.length > 14 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w;
}

/* ------------------------------------------------------------------ */
/* PurchaseCompleted log decoding (marketplace sales, on-chain truth)  */
/* ------------------------------------------------------------------ */

export const TIPS_CONTRACT_ID = "0.0.10854060";
export const MIRROR_NODE = "https://mainnet.mirrornode.hedera.com/api/v1";
/** keccak256("PurchaseCompleted(address,address,string,uint256,uint256)") */
export const PURCHASE_COMPLETED_TOPIC0 =
  "0x8555727c6813e10ae0b5a9b0a53a88a93176679845f5a005a248cdb9f1c05f2e";

export interface MirrorLog {
  transaction_hash?: string;
  timestamp?: string;
  topics?: string[];
  data?: string;
}

export interface DecodedPurchase {
  txHash: string;
  /** Consensus timestamp, seconds (float). */
  timestampSec: number;
  /** Buyer EVM address (topic1). */
  buyer: string;
  /** Seller EVM address (topic2). */
  seller: string;
  /** Amount paid in HBAR, 4 decimals. */
  amountHbar: string;
  /** Listing id passed as listingRef, or null when undecodable. */
  listingRef: string | null;
}

const LISTING_ID_RE = /^[a-z0-9-]{8,64}$/;

/**
 * Decode one mirror-node log into a purchase, or null when it isn't a
 * PurchaseCompleted log or is malformed. Never throws, never guesses.
 */
export function decodePurchaseLog(log: MirrorLog): DecodedPurchase | null {
  try {
    const topics = log.topics ?? [];
    if ((topics[0] ?? "").toLowerCase() !== PURCHASE_COMPLETED_TOPIC0) return null;
    const buyer = topics[1] ? "0x" + topics[1].slice(-40).toLowerCase() : null;
    const seller = topics[2] ? "0x" + topics[2].slice(-40).toLowerCase() : null;
    if (!buyer || !seller) return null;
    if (!/^0x[0-9a-f]{40}$/.test(buyer) || !/^0x[0-9a-f]{40}$/.test(seller)) return null;
    // data = offset(32) | amount uint256 | fee uint256 | strlen(32) | string bytes
    // Fewer than 3 ABI words means garbage, not a PurchaseCompleted event.
    const data = typeof log.data === "string" && log.data.startsWith("0x") ? log.data.slice(2) : "";
    if (!/^[0-9a-fA-F]+$/.test(data) || data.length < 192) return null;
    let amountHbar = "0";
    let listingRef: string | null = null;
    {
      const hex = data;
      const amountWei = BigInt("0x" + hex.slice(64, 128));
      amountHbar = (Number(amountWei) / 100_000_000).toFixed(4);
      // Decode the listingRef string via its ABI offset.
      const offsetBytes = Number(BigInt("0x" + hex.slice(0, 64)));
      const strPos = offsetBytes * 2;
      if (
        Number.isInteger(offsetBytes) &&
        offsetBytes >= 0 &&
        strPos + 64 <= hex.length
      ) {
        const len = Number(BigInt("0x" + hex.slice(strPos, strPos + 64)));
        const bytesStart = strPos + 64;
        if (Number.isInteger(len) && len >= 0 && bytesStart + len * 2 <= hex.length) {
          const raw = Buffer.from(hex.slice(bytesStart, bytesStart + len * 2), "hex").toString("utf8");
          if (LISTING_ID_RE.test(raw)) listingRef = raw;
        }
      }
    }
    const timestampSec = parseFloat(log.timestamp ?? "");
    if (!Number.isFinite(timestampSec)) return null;
    const txHash = typeof log.transaction_hash === "string" ? log.transaction_hash : "";
    if (!txHash) return null;
    return { txHash, timestampSec, buyer, seller, amountHbar, listingRef };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Sweep                                                               */
/* ------------------------------------------------------------------ */

export interface SocialSweepDeps {
  kv: KvStore;
  hcs: HcsPort;
  registry: RegistryPort;
  fetchImpl?: typeof fetch;
  sender?: PushSender;
  /** When false, detection + inbox writes run but no push is sent. */
  sendPush: boolean;
  /** Canonical site origin, e.g. https://voicescape.vercel.app */
  siteUrl: string;
  /** Resolve a wallet to its registered username for display (optional). */
  resolveUsername?: (wallet: string) => Promise<string | null>;
}

export interface SocialSweepResult {
  checked: number;
  /** Events detected (inbox writes). */
  events: number;
  /** Push notifications sent. */
  sent: number;
  pruned: number;
  skipped?: string;
}

interface SweepCtx {
  kv: KvStore;
  hcs: HcsPort;
  registry: RegistryPort;
  fetchImpl: typeof fetch;
  sender: PushSender;
  sendPush: boolean;
  siteUrl: string;
  resolveUsername?: (wallet: string) => Promise<string | null>;
  counts: { checked: number; events: number; sent: number; pruned: number };
  vapid: { subject: string; publicKey: string; privateKey: string } | null;
}

async function readSeqWatermark(kv: KvStore, key: string): Promise<number> {
  const raw = await kv.get(key);
  const v = raw == null ? NaN : parseInt(raw, 10);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

async function displayName(
  ctx: SweepCtx,
  wallet: string,
  fallback: string,
): Promise<string> {
  if (!ctx.resolveUsername) return fallback;
  try {
    const name = await ctx.resolveUsername(wallet);
    return name ? `@${name}` : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Emit one detected event: exactly-once inbox write, plus push when the
 * sweep runs in push mode and the target wallet has opted-in devices.
 */
async function emitEvent(
  ctx: SweepCtx,
  targetWallet: string,
  notif: SocialNotif,
): Promise<void> {
  const { kv } = ctx;
  const wallet = targetWallet.trim().toLowerCase();
  if (!wallet) return;
  const claimed = await kv.setNx(`${NOTIF_SENT_PREFIX}${notif.id}`, "1", PUSH_SENT_TTL_MS);
  if (!claimed) return;
  await appendInbox(kv, wallet, notif);
  ctx.counts.events += 1;

  if (!ctx.sendPush) return;
  const subs = await listSubscriptions(kv, wallet);
  if (subs.length === 0) return;
  if (!ctx.vapid) return;
  const payload: PushPayload = {
    title: notif.title,
    body: notif.body,
    url: ctx.siteUrl + notif.url,
  };
  for (const sub of subs) {
    try {
      await ctx.sender(sub, payload, ctx.vapid);
      ctx.counts.sent += 1;
    } catch (err) {
      if (isGoneError(err)) {
        await removeSubscription(kv, wallet, sub.endpoint);
        ctx.counts.pruned += 1;
      } else {
        console.error(
          `[notify] push send failed for ${notif.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

async function resolveTargetWallet(
  ctx: SweepCtx,
  username: string,
): Promise<string | null> {
  try {
    const owner = await ctx.registry.resolveOwner(username);
    return owner ? owner.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function parentAuthorOf(
  ctx: SweepCtx,
  forumTopic: string,
  parentSeq: number,
): Promise<string | null> {
  const cached = await ctx.kv.get(`${NOTIF_AUTHOR_PREFIX}${parentSeq}`);
  if (cached) return cached;
  // Targeted single-message query: ascending order, so the first message
  // with seq > parentSeq-1 is the parent itself when it exists.
  try {
    const msgs = await ctx.hcs.query(forumTopic, { afterSeq: parentSeq - 1, limit: 1 });
    const parent = msgs.find((m) => m.seq === parentSeq);
    if (parent && parent.contents.kind === "post") {
      const author = (parent.contents as PostMessage).author;
      if (typeof author === "string" && author) {
        await ctx.kv.set(`${NOTIF_AUTHOR_PREFIX}${parentSeq}`, author, NOTIF_AUTHOR_TTL_MS);
        return author;
      }
    }
  } catch {
    /* mirror hiccup — skip this reply rather than guessing */
  }
  return null;
}

async function sweepForum(ctx: SweepCtx): Promise<void> {
  const topic = getTopicId("forum");
  if (!topic) return;
  let watermark = await readSeqWatermark(ctx.kv, NOTIF_FORUM_SEQ_KV_KEY);
  let afterSeq = watermark;
  let maxSeq = watermark;
  let scanned = 0;
  for (;;) {
    let msgs: StoredMessage[];
    try {
      msgs = await ctx.hcs.query(topic, { afterSeq, limit: 100 });
    } catch (e) {
      console.error(`[notify] forum sweep query failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (msgs.length === 0) break;
    for (const m of msgs) {
      if (m.seq > maxSeq) maxSeq = m.seq;
      if (m.contents.kind !== "post") continue;
      const p = m.contents as PostMessage;
      const author = typeof p.author === "string" ? p.author.toLowerCase() : "";
      if (!author) continue;
      ctx.counts.checked += 1;
      try {
        await ctx.kv.set(`${NOTIF_AUTHOR_PREFIX}${m.seq}`, author, NOTIF_AUTHOR_TTL_MS);
      } catch {
        /* cache write is best-effort */
      }
      const tsMs = Date.parse(p.ts);
      const at = Number.isFinite(tsMs) ? tsMs : Date.now();

      // (a) Reply to someone's post.
      if (p.replyTo != null && Number.isInteger(p.replyTo)) {
        const parentAuthor = await parentAuthorOf(ctx, topic, p.replyTo);
        if (parentAuthor && parentAuthor.toLowerCase() !== author) {
          const wallet = await resolveTargetWallet(ctx, parentAuthor);
          if (wallet) {
            await emitEvent(ctx, wallet, {
              id: `reply:forum:${m.seq}`,
              type: "reply",
              tsMs: at,
              actor: `@${author}`,
              title: "New reply to your post",
              body: `@${author} replied: "${snippet(p.body)}"`,
              url: `/forum/${encodeURIComponent(p.board || "general")}`,
            });
          }
        }
      } else if (typeof p.wall === "string" && p.wall && p.wall.toLowerCase() !== author) {
        // Top-level post on someone's wall.
        const wallOwner = p.wall.toLowerCase();
        const wallet = await resolveTargetWallet(ctx, wallOwner);
        if (wallet) {
          await emitEvent(ctx, wallet, {
            id: `wallpost:forum:${m.seq}`,
            type: "reply",
            tsMs: at,
            actor: `@${author}`,
            title: "New post on your wall",
            body: `@${author} posted on your wall: "${snippet(p.body)}"`,
            url: `/${encodeURIComponent(wallOwner)}`,
          });
        }
      }

      // (b) @mentions in the post body.
      for (const mentioned of extractMentions(p.body)) {
        if (mentioned === author) continue;
        const wallet = await resolveTargetWallet(ctx, mentioned);
        if (!wallet) continue;
        await emitEvent(ctx, wallet, {
          id: `mention:forum:${m.seq}:${mentioned}`,
          type: "mention",
          tsMs: at,
          actor: `@${author}`,
          title: "You were mentioned",
          body: `@${author} mentioned you: "${snippet(p.body)}"`,
          url: `/forum/${encodeURIComponent(p.board || "general")}`,
        });
      }
    }
    scanned += msgs.length;
    afterSeq = msgs[msgs.length - 1].seq;
    if (msgs.length < 100 || scanned >= NOTIF_SWEEP_MSG_CAP) break;
  }
  try {
    await ctx.kv.set(NOTIF_FORUM_SEQ_KV_KEY, String(maxSeq), NOTIF_AUTHOR_TTL_MS);
  } catch {
    /* watermark write is best-effort */
  }
}

async function sweepChat(ctx: SweepCtx): Promise<void> {
  const topic = getTopicId("chat");
  if (!topic) return;
  let watermark = await readSeqWatermark(ctx.kv, NOTIF_CHAT_SEQ_KV_KEY);
  let afterSeq = watermark;
  let maxSeq = watermark;
  let scanned = 0;
  for (;;) {
    let msgs: StoredMessage[];
    try {
      msgs = await ctx.hcs.query(topic, { afterSeq, limit: 100 });
    } catch (e) {
      console.error(`[notify] chat sweep query failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (msgs.length === 0) break;
    for (const m of msgs) {
      if (m.seq > maxSeq) maxSeq = m.seq;
      if (m.contents.kind !== "chat") continue;
      const c = m.contents as ChatMessage;
      const author = typeof c.author === "string" ? c.author.toLowerCase() : "";
      if (!author) continue;
      ctx.counts.checked += 1;
      const tsMs = Date.parse(c.ts);
      const at = Number.isFinite(tsMs) ? tsMs : Date.now();
      for (const mentioned of extractMentions(c.body)) {
        if (mentioned === author) continue;
        const wallet = await resolveTargetWallet(ctx, mentioned);
        if (!wallet) continue;
        await emitEvent(ctx, wallet, {
          id: `mention:chat:${m.seq}:${mentioned}`,
          type: "mention",
          tsMs: at,
          actor: `@${author}`,
          title: "You were mentioned",
          body: `@${author} mentioned you in #${c.room}: "${snippet(c.body)}"`,
          url: `/chat/${encodeURIComponent(c.room)}`,
        });
      }
    }
    scanned += msgs.length;
    afterSeq = msgs[msgs.length - 1].seq;
    if (msgs.length < 100 || scanned >= NOTIF_SWEEP_MSG_CAP) break;
  }
  try {
    await ctx.kv.set(NOTIF_CHAT_SEQ_KV_KEY, String(maxSeq), NOTIF_AUTHOR_TTL_MS);
  } catch {
    /* watermark write is best-effort */
  }
}

async function sweepFollows(ctx: SweepCtx): Promise<void> {
  const events = parseFollowEvents(await ctx.kv.get(NOTIF_FOLLOW_EVENTS_KV_KEY));
  const idxRaw = await ctx.kv.get(NOTIF_FOLLOW_EVENTS_IDX_KV_KEY);
  let idx = idxRaw == null ? 0 : parseInt(idxRaw, 10);
  // The log is capped and may have been trimmed since the last run — the
  // per-event setNx idempotency keys make reprocessing safe.
  if (!Number.isFinite(idx) || idx < 0 || idx > events.length) idx = 0;
  for (let i = idx; i < events.length; i++) {
    const e = events[i];
    ctx.counts.checked += 1;
    const wallet = await resolveTargetWallet(ctx, e.username);
    if (!wallet) continue;
    // Don't notify yourself about your own follow (self-follows are
    // rejected, but stay safe).
    if (wallet === e.followerWallet) continue;
    const actor = await displayName(ctx, e.followerWallet, "Someone new");
    await emitEvent(ctx, wallet, {
      id: e.id,
      type: "follow",
      tsMs: e.tsMs,
      actor,
      title: "New follower",
      body: `${actor} started following your page`,
      url: `/${encodeURIComponent(e.username)}`,
    });
  }
  try {
    await ctx.kv.set(NOTIF_FOLLOW_EVENTS_IDX_KV_KEY, String(events.length), NOTIF_FOLLOW_EVENTS_TTL_MS);
  } catch {
    /* watermark write is best-effort */
  }
}

async function fetchPurchaseLogs(
  fetchImpl: typeof fetch,
  sinceSec: number,
): Promise<MirrorLog[]> {
  // Mirror-node topic searches require a BOUNDED timestamp range.
  const nowSec = Math.floor(Date.now() / 1000);
  const url =
    `${MIRROR_NODE}/contracts/${TIPS_CONTRACT_ID}/results/logs` +
    `?order=desc&limit=50&topic0=${PURCHASE_COMPLETED_TOPIC0}` +
    `&timestamp=gte:${sinceSec}.000000000&timestamp=lte:${nowSec}.999999999`;
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`mirror node responded ${res.status}`);
  const json = (await res.json()) as { logs?: unknown };
  return Array.isArray(json.logs) ? (json.logs as MirrorLog[]) : [];
}

async function sweepPurchases(ctx: SweepCtx): Promise<void> {
  const wmRaw = await ctx.kv.get(NOTIF_PURCHASE_TS_KV_KEY);
  const wmParsed = wmRaw == null ? NaN : parseFloat(wmRaw);
  const watermark = Number.isFinite(wmParsed) ? wmParsed : 0;
  const sinceSec = watermark > 0 ? Math.floor(watermark) : Math.floor(Date.now() / 1000) - 86_400;
  let logs: MirrorLog[];
  try {
    logs = await fetchPurchaseLogs(ctx.fetchImpl, sinceSec);
  } catch (e) {
    console.error(`[notify] purchase sweep fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  let maxTs = watermark;
  for (const log of logs) {
    const ts = parseFloat(log.timestamp ?? "");
    if (Number.isFinite(ts) && ts > maxTs) maxTs = ts;
  }
  for (const log of logs) {
    const p = decodePurchaseLog(log);
    // Skip undecodable entries: without a listingRef we can't deep-link
    // to the sold item, and a vague "/marketplace" link isn't honest.
    if (!p || !p.listingRef || p.timestampSec <= watermark) continue;
    ctx.counts.checked += 1;
    const buyerName = await displayName(ctx, p.buyer, shortWallet(p.buyer));
    const url = p.listingRef ? `/marketplace/${encodeURIComponent(p.listingRef)}` : "/marketplace";
    await emitEvent(ctx, p.seller, {
      id: `sale:${p.txHash.toLowerCase()}`,
      type: "sale",
      tsMs: Math.round(p.timestampSec * 1000),
      actor: buyerName,
      title: "Your item sold",
      body: `${buyerName} bought your marketplace item for ${p.amountHbar} HBAR`,
      url,
    });
  }
  try {
    await ctx.kv.set(NOTIF_PURCHASE_TS_KV_KEY, String(maxTs), NOTIF_AUTHOR_TTL_MS);
  } catch {
    /* watermark write is best-effort */
  }
}

/**
 * Run one full social sweep: forum replies + mentions, chat mentions,
 * follow events, marketplace sales. Pure orchestration over injected deps
 * so tests can drive it without the network, real KV, or web-push.
 */
export async function runSocialSweep(
  deps: SocialSweepDeps,
): Promise<{ status: 200; body: SocialSweepResult } | { status: 401 | 503; body: { error: string } }> {
  const {
    kv,
    hcs,
    registry,
    fetchImpl = fetch,
    sender = webPushSender,
    sendPush,
    siteUrl,
    resolveUsername,
  } = deps;

  const ctx: SweepCtx = {
    kv,
    hcs,
    registry,
    fetchImpl,
    sender,
    sendPush,
    siteUrl,
    resolveUsername,
    counts: { checked: 0, events: 0, sent: 0, pruned: 0 },
    vapid: null,
  };

  if (sendPush) {
    try {
      const keypair = await ensureVapidKeypair(kv);
      ctx.vapid = { subject: VAPID_SUBJECT, publicKey: keypair.publicKey, privateKey: keypair.privateKey };
    } catch (e) {
      console.error(`[notify] VAPID keypair unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return { status: 503, body: { error: "push unavailable — try again in a moment" } };
    }
  }

  await sweepForum(ctx);
  await sweepChat(ctx);
  await sweepFollows(ctx);
  await sweepPurchases(ctx);

  try {
    await kv.set(NOTIF_LAST_RUN_KV_KEY, String(Date.now()), NOTIF_AUTHOR_TTL_MS);
  } catch {
    /* best-effort */
  }

  return {
    status: 200,
    body: {
      checked: ctx.counts.checked,
      events: ctx.counts.events,
      sent: ctx.counts.sent,
      pruned: ctx.counts.pruned,
    },
  };
}

/** Re-exported for the /api/notify/check route's auth pattern. */
export { secretsMatch };

/**
 * Read-path backfill: run detection (no push) when the last sweep is
 * stale, so the bell and digest populate even before any cron is wired.
 * Never throws — a failed backfill just means stale data, honestly shown.
 */
export async function maybeBackfillSocial(
  kv: KvStore,
  hcs: HcsPort,
  registry: RegistryPort,
  siteUrl: string,
): Promise<void> {
  try {
    const raw = await kv.get(NOTIF_LAST_RUN_KV_KEY);
    const last = raw == null ? NaN : parseInt(raw, 10);
    if (Number.isFinite(last) && Date.now() - last < NOTIF_BACKFILL_MIN_INTERVAL_MS) return;
    await runSocialSweep({ kv, hcs, registry, sendPush: false, siteUrl });
  } catch {
    /* backfill is best-effort */
  }
}

/* ------------------------------------------------------------------ */
/* Tip items for the digest (light mirror-node read, no per-log tx      */
/* resolution — the bell's /api/notifications keeps the rich version)  */
/* ------------------------------------------------------------------ */

const TIPSENT_TOPIC0 =
  "0xddb557901a5c7e767f2276c1190ca61ae148d62a74cfa61e4f7fa5319eaa431e";

/**
 * Recent tip events for a wallet as digest items. `sinceMs` filters;
 * `limit` bounds the mirror-node read. Never throws — returns [] on any
 * failure so the digest degrades to social-only, honestly.
 */
export async function fetchTipItems(
  address: string,
  sinceMs: number,
  limit = 20,
): Promise<DigestItem[]> {
  const forms = addressForms(address);
  const evm = forms.find((f) => /^0x[0-9a-f]{40}$/.test(f));
  if (!evm) return [];
  try {
    const topicAddress = "0x" + evm.slice(2).padStart(64, "0");
    const url =
      `${MIRROR_NODE}/contracts/${TIPS_CONTRACT_ID}/results/logs` +
      `?order=desc&limit=${Math.min(Math.max(limit, 1), 50)}&topic3=${topicAddress}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const data = (await res.json()) as { logs?: unknown };
    const logs = Array.isArray(data.logs) ? (data.logs as MirrorLog[]) : [];
    const out: DigestItem[] = [];
    for (const log of logs) {
      if ((log.topics?.[0] ?? "").toLowerCase() !== TIPSENT_TOPIC0) continue;
      const from = log.topics?.[2] ? "0x" + log.topics[2].slice(-40).toLowerCase() : null;
      if (!from || !/^0x[0-9a-f]{40}$/.test(from)) continue;
      const tsMs = Math.round(parseFloat(log.timestamp ?? "") * 1000);
      if (!Number.isFinite(tsMs) || tsMs <= sinceMs) continue;
      let amountHbar = "0";
      if (log.data && log.data.length >= 66) {
        try {
          amountHbar = (Number(BigInt("0x" + log.data.slice(2, 66))) / 100_000_000).toFixed(4);
        } catch {
          continue;
        }
      }
      const txHash = typeof log.transaction_hash === "string" ? log.transaction_hash : "";
      out.push({
        id: `tip:${txHash.toLowerCase() || `${tsMs}-${from}`}`,
        type: "tip",
        tsMs,
        actor: shortWallet(from),
        title: "New tip received",
        body: `You received ${amountHbar} HBAR`,
        url: txHash
          ? `https://hashscan.io/mainnet/transaction/${txHash}`
          : "/",
      });
    }
    return out.sort((a, b) => b.tsMs - a.tsMs);
  } catch {
    return [];
  }
}

/** Clamp a client-supplied `since` ms to a sane window (default 24h, max 30d). */
export function clampSinceMs(raw: unknown): number {
  const now = Date.now();
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return now - DAY_MS;
  if (n > now) return now - DAY_MS;
  if (now - n > 30 * DAY_MS) return now - 30 * DAY_MS;
  return Math.floor(n);
}
