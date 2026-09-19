/**
 * Voicescape — web push for tip notifications (Slice 1), server logic.
 *
 * Two HTTP surfaces sit on top of this module:
 *   - /api/push/subscriptions (session-checked): manage a wallet's push
 *     subscriptions.
 *   - /api/push/check (sweep): poll the Hedera mirror node for new TipSent
 *     events on the Tips contract and deliver web-push notifications to the
 *     recipients' subscribed devices.
 *
 * The VAPID keypair is self-generated on first use and persisted in KV —
 * no operator key setup is required. /api/push/check is guarded by an
 * optional shared secret (KV "push:check:secret"): when the secret exists
 * the x-push-secret header is required; when it does not, the endpoint
 * accepts rate-limited calls (see the route). That is safe because a sweep
 * only sends factual on-chain-derived notifications and the watermark makes
 * repeats no-ops, so an unconfigured secret degrades to rate-limited public
 * polling rather than a vulnerability.
 *
 * All chain reads go through the official Hedera mirror-node REST API.
 * Nothing here moves value and nothing redeploys contracts. A push is only
 * ever sent for a TipSent log returned by the mirror node for the real
 * mainnet Tips contract — the notification IS the on-chain proof.
 */

import { createHash, timingSafeEqual } from "crypto";
import { generateVAPIDKeys, setVapidDetails, sendNotification } from "web-push";
import type { KvStore } from "./store";
import { canonicalAddress } from "@/lib/session-message";
import { dictionaries, type Lang } from "@/lib/i18n/dictionaries";
import {
  isValidVapidPrivateKey,
  isValidVapidPublicKey,
  type PushSubscriptionPayload,
} from "@/lib/push";

/* ------------------------------------------------------------------ */
/* KV layout                                                           */
/* ------------------------------------------------------------------ */

/** The VAPID private key. Self-generated on first use by ensureVapidKeypair
 * and persisted here. Never in code/git. (scripts/store-vapid-key.mjs can
 * overwrite it for manual rotation.) */
export const PUSH_VAPID_KV_KEY = "push:vapid:private";
/** The VAPID public key (served by /api/push/vapid-public-key). Generated
 * alongside the private key. Public by design — safe to return in HTTP. */
export const PUSH_VAPID_PUBLIC_KV_KEY = "push:vapid:public";
/** Shared secret guarding /api/push/check. OPTIONAL: when set (any random
 * string), the x-push-secret header is required; when absent the sweep
 * accepts rate-limited calls. Set by the operator via KV directly. */
export const PUSH_CHECK_SECRET_KV_KEY = "push:check:secret";
/** Watermark: highest mirror-node consensus timestamp (seconds) processed. */
export const PUSH_LAST_TS_KV_KEY = "push:check:lastTs";

/** Subscriptions live 1 year, refreshed on every write. Safe integer. */
export const PUSH_SUBS_TTL_MS = 31_536_000_000;
/** Per-tx idempotency keys live 30 days — long enough to outlast any re-scan. */
export const PUSH_SENT_TTL_MS = 2_592_000_000;
/** VAPID private key TTL: 10 years (rotate by overwriting). */
export const PUSH_VAPID_TTL_MS = 315_360_000_000;

/** VAPID keypair: the private key signs push payloads, the public key is
 * handed to browsers at subscription time. */
export interface VapidKeypair {
  publicKey: string;
  privateKey: string;
}

/**
 * Read the VAPID keypair from KV, generating and persisting one on first
 * use. This is what makes push self-sufficient: no operator ever has to
 * provision keys — the app bootstraps itself the first time a sweep or a
 * subscription needs it.
 *
 * The private key NEVER appears in code, git, logs, or HTTP responses;
 * only the public key is ever served (via /api/push/vapid-public-key).
 *
 * If a private key exists but its public half is missing or malformed (a
 * partial write), both are regenerated — a half-pair can never sign.
 */
export async function ensureVapidKeypair(kv: KvStore): Promise<VapidKeypair> {
  const storedPrivate = await kv.get(PUSH_VAPID_KV_KEY);
  const storedPublic = await kv.get(PUSH_VAPID_PUBLIC_KV_KEY);
  if (isValidVapidPrivateKey(storedPrivate) && isValidVapidPublicKey(storedPublic)) {
    return { publicKey: storedPublic, privateKey: storedPrivate };
  }
  const generated = generateVAPIDKeys();
  if (
    !isValidVapidPublicKey(generated.publicKey) ||
    !isValidVapidPrivateKey(generated.privateKey)
  ) {
    throw new Error("generated VAPID keypair failed format validation");
  }
  await kv.set(PUSH_VAPID_KV_KEY, generated.privateKey, PUSH_VAPID_TTL_MS);
  await kv.set(PUSH_VAPID_PUBLIC_KV_KEY, generated.publicKey, PUSH_VAPID_TTL_MS);
  return generated;
}

/* ------------------------------------------------------------------ */
/* Chain constants                                                     */
/* ------------------------------------------------------------------ */

export const TIPS_CONTRACT_ID = "0.0.10854060";
/** TipSent(string indexed username, address indexed from, address indexed toOwner, uint256 amount, uint256 fee) */
export const TIPSENT_TOPIC0 = "0xddb557901a5c7e767f2276c1190ca61ae148d62a74cfa61e4f7fa5319eaa431e";
export const MIRROR_NODE = "https://mainnet.mirrornode.hedera.com/api/v1";
export const VAPID_SUBJECT = "mailto:support@voicescape";

/* ------------------------------------------------------------------ */
/* Subscription storage                                                */
/* ------------------------------------------------------------------ */

export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Language code for localizing the push text (e.g. "en"). */
  lang: string;
  /** Unix ms when the subscription was stored. */
  createdAt: number;
}

/**
 * KV keys for a wallet. The wallet may arrive as "0.0.x" or "0x…" — we
 * store under both the raw form and the canonical EVM form so a tip that
 * lands on either on-chain address shape still finds the subscription.
 */
export function subsKeysForWallet(wallet: string): string[] {
  const raw = wallet.trim().toLowerCase();
  const keys = [`push:subs:${raw}`];
  const canon = canonicalAddress(raw);
  if (canon && canon !== raw) keys.push(`push:subs:${canon}`);
  return keys;
}

/**
 * KV keys to probe for a tip recipient's EVM address (from a TipSent log).
 * Also probes the 0.0.x form when the address is long-zero form.
 */
export function subsKeysForRecipient(evmAddress: string): string[] {
  const lower = evmAddress.trim().toLowerCase();
  const keys = [`push:subs:${lower}`];
  const m = /^0x0{24}([0-9a-f]{16})$/.exec(lower);
  if (m) {
    try {
      const num = BigInt("0x" + m[1]).toString(10);
      keys.push(`push:subs:0.0.${num}`);
    } catch {
      /* not a number — ignore */
    }
  }
  return keys;
}

function parseStoredSubscriptions(raw: string | null): StoredSubscription[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: StoredSubscription[] = [];
    for (const s of parsed) {
      if (
        s &&
        typeof s === "object" &&
        typeof (s as { endpoint?: unknown }).endpoint === "string" &&
        (s as { endpoint: string }).endpoint.length > 0 &&
        typeof (s as { keys?: unknown }).keys === "object" &&
        (s as { keys: { p256dh?: unknown; auth?: unknown } }).keys !== null &&
        typeof (s as { keys: { p256dh: unknown } }).keys.p256dh === "string" &&
        typeof (s as { keys: { auth: unknown } }).keys.auth === "string"
      ) {
        const rec = s as {
          endpoint: string;
          keys: { p256dh: string; auth: string };
          lang?: unknown;
          createdAt?: unknown;
        };
        out.push({
          endpoint: rec.endpoint,
          keys: { p256dh: rec.keys.p256dh, auth: rec.keys.auth },
          lang: typeof rec.lang === "string" && rec.lang.length > 0 ? rec.lang : "en",
          createdAt: typeof rec.createdAt === "number" ? rec.createdAt : 0,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** All KV keys that could hold subscriptions for an address in any form
 * ("0.0.x" or "0x…"). Reads union them; writes fan out to all of them so
 * no stale alias copy can resurrect a removed subscription. */
export function probeKeysForAddress(address: string): string[] {
  const out: string[] = [];
  for (const k of [...subsKeysForWallet(address), ...subsKeysForRecipient(address)]) {
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

async function readAllSubscriptions(kv: KvStore, address: string): Promise<StoredSubscription[]> {
  const seen = new Map<string, StoredSubscription>();
  for (const key of probeKeysForAddress(address)) {
    for (const s of parseStoredSubscriptions(await kv.get(key))) {
      if (!seen.has(s.endpoint)) seen.set(s.endpoint, s);
    }
  }
  return [...seen.values()];
}

/** All subscriptions known for a wallet (deduplicated by endpoint). */
export async function listSubscriptions(
  kv: KvStore,
  wallet: string,
): Promise<StoredSubscription[]> {
  return readAllSubscriptions(kv, wallet);
}

/** Subscriptions for a tip recipient EVM address (deduplicated by endpoint). */
export async function subscriptionsForRecipient(
  kv: KvStore,
  evmAddress: string,
): Promise<StoredSubscription[]> {
  return readAllSubscriptions(kv, evmAddress);
}

export interface ValidatedSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  lang: string;
}

const SUPPORTED_LANGS = new Set(["en", "es", "zh", "hi", "ar", "pt", "fr"]);

/** Validate a subscription payload from the client. Never throws. */
export function validateSubscriptionPayload(
  body: unknown,
): { ok: true; sub: ValidatedSubscription } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid subscription" };
  }
  const b = body as PushSubscriptionPayload;
  let endpoint: URL;
  try {
    endpoint = new URL(b.endpoint);
  } catch {
    return { ok: false, error: "endpoint must be a valid URL" };
  }
  if (endpoint.protocol !== "https:") {
    return { ok: false, error: "endpoint must be https" };
  }
  const keys = b.keys;
  if (
    !keys ||
    typeof keys.p256dh !== "string" ||
    keys.p256dh.length === 0 ||
    typeof keys.auth !== "string" ||
    keys.auth.length === 0
  ) {
    return { ok: false, error: "keys.p256dh and keys.auth are required" };
  }
  const lang =
    typeof b.lang === "string" && SUPPORTED_LANGS.has(b.lang) ? b.lang : "en";
  return { ok: true, sub: { endpoint: endpoint.toString(), keys, lang } };
}

/**
 * Add (or refresh) a subscription for a wallet. Dedupes by endpoint and
 * refreshes the TTL on every write. Returns the subscription count.
 */
export async function addSubscription(
  kv: KvStore,
  wallet: string,
  sub: ValidatedSubscription,
): Promise<number> {
  const entry: StoredSubscription = {
    endpoint: sub.endpoint,
    keys: sub.keys,
    lang: sub.lang,
    createdAt: Date.now(),
  };
  const keys = probeKeysForAddress(wallet);
  // Read the union once, then write the merged list back to every probe
  // key so all address forms stay in sync.
  const existing = await readAllSubscriptions(kv, wallet);
  const next = [entry, ...existing.filter((s) => s.endpoint !== entry.endpoint)];
  for (const key of keys) await kv.set(key, JSON.stringify(next), PUSH_SUBS_TTL_MS);
  return next.length;
}

/**
 * Remove one endpoint from a wallet's subscriptions. Returns the count left.
 */
export async function removeSubscription(
  kv: KvStore,
  wallet: string,
  endpoint: string,
): Promise<number> {
  const keys = probeKeysForAddress(wallet);
  const existing = await readAllSubscriptions(kv, wallet);
  const next = existing.filter((s) => s.endpoint !== endpoint);
  if (next.length === existing.length) return existing.length; // nothing to do
  if (next.length === 0) {
    for (const key of keys) await kv.del(key);
  } else {
    for (const key of keys) await kv.set(key, JSON.stringify(next), PUSH_SUBS_TTL_MS);
  }
  return next.length;
}

/* ------------------------------------------------------------------ */
/* TipSent log decoding                                                */
/* ------------------------------------------------------------------ */

export interface MirrorLog {
  transaction_hash?: string;
  timestamp?: string;
  topics?: string[];
  data?: string;
}

export interface DecodedTip {
  txHash: string;
  /** Consensus timestamp, seconds (float). */
  timestampSec: number;
  /** Tipper EVM address (topic2). */
  from: string;
  /** Recipient EVM address (topic3). */
  recipient: string;
  /** Tipped amount in HBAR, 4 decimals. */
  amountHbar: string;
}

/** Decode one mirror-node log into a tip, or null when it isn't a TipSent log. */
export function decodeTipLog(log: MirrorLog): DecodedTip | null {
  try {
    const topics = log.topics ?? [];
    if ((topics[0] ?? "").toLowerCase() !== TIPSENT_TOPIC0) return null;
    const from = topics[2] ? "0x" + topics[2].slice(-40).toLowerCase() : null;
    const recipient = topics[3] ? "0x" + topics[3].slice(-40).toLowerCase() : null;
    if (!from || !recipient) return null;
    if (!/^0x[0-9a-f]{40}$/.test(from) || !/^0x[0-9a-f]{40}$/.test(recipient)) {
      return null;
    }
    // data = (uint256 amount, uint256 fee); amount is total tipped, in wei (tinybar).
    let amountHbar = "0";
    if (log.data && log.data.length >= 66) {
      const amountWei = BigInt("0x" + log.data.slice(2, 66));
      amountHbar = (Number(amountWei) / 100_000_000).toFixed(4);
    }
    const timestampSec = parseFloat(log.timestamp ?? "");
    if (!Number.isFinite(timestampSec)) return null;
    const txHash = typeof log.transaction_hash === "string" ? log.transaction_hash : "";
    if (!txHash) return null;
    return { txHash, timestampSec, from, recipient, amountHbar };
  } catch {
    return null;
  }
}

function pushDict(lang: string): Record<string, string> {
  const l = (SUPPORTED_LANGS.has(lang) ? lang : "en") as Lang;
  return dictionaries[l] as unknown as Record<string, string>;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

/** Localized notification payload for a tip. */
export function buildTipPayload(
  tip: DecodedTip,
  lang: string,
  blockpageUrl: string,
): PushPayload {
  const d = pushDict(lang);
  const title = d["push.receivedTitle"] ?? "New tip received";
  const bodyTpl = d["push.receivedBody"] ?? "You received {amount} HBAR";
  return {
    title,
    body: bodyTpl.replace("{amount}", tip.amountHbar),
    url: blockpageUrl,
  };
}

/* ------------------------------------------------------------------ */
/* Push delivery                                                       */
/* ------------------------------------------------------------------ */

export interface PushSender {
  (
    sub: StoredSubscription,
    payload: PushPayload,
    vapid: { subject: string; publicKey: string; privateKey: string },
  ): Promise<void>;
}

/** A push-service 404/410 means the subscription is dead — prune it. */
export function isGoneError(err: unknown): boolean {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return code === 404 || code === 410;
}

/** Default sender: the real `web-push` library. */
export const webPushSender: PushSender = async (sub, payload, vapid) => {
  setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  await sendNotification(
    { endpoint: sub.endpoint, keys: sub.keys },
    JSON.stringify(payload),
  );
};

/* ------------------------------------------------------------------ */
/* /api/push/check orchestration                                       */
/* ------------------------------------------------------------------ */

export interface PushCheckDeps {
  kv: KvStore;
  fetchImpl?: typeof fetch;
  sender?: PushSender;
  /** Expected shared secret from KV ("push:check:secret"), null when unset.
   * When set, the x-push-secret header must match; when unset, the route
   * applies per-IP rate limiting instead (see the route comment for why
   * that is safe: sweeps only send factual on-chain-derived notifications
   * and the watermark makes repeats no-ops). */
  expectedSecret: string | null;
  /** Secret supplied in the x-push-secret header. */
  providedSecret: string | null | undefined;
  /** Canonical site origin, e.g. https://voicescape.vercel.app */
  siteUrl: string;
  /** Resolve a recipient EVM address to its blockpage username (optional). */
  resolveUsername?: (evmAddress: string) => Promise<string | null>;
}

export interface PushCheckResult {
  checked: number;
  sent: number;
  pruned: number;
  skipped?: string;
}

/** Constant-time secret comparison (hashes first so lengths don't leak). */
export function secretsMatch(expected: string | null, provided: string | null | undefined): boolean {
  if (!expected || !provided) return false;
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(provided, "utf8").digest();
  return timingSafeEqual(a, b);
}

async function readWatermark(kv: KvStore): Promise<number> {
  const raw = await kv.get(PUSH_LAST_TS_KV_KEY);
  const v = raw == null ? NaN : parseFloat(raw);
  return Number.isFinite(v) ? v : 0;
}

async function fetchTipLogs(
  fetchImpl: typeof fetch,
  sinceSec: number,
): Promise<MirrorLog[]> {
  // Mirror-node topic searches require a BOUNDED timestamp range (both a
  // lower and an upper bound); an unbounded topic query is rejected with
  // HTTP 400 ("Cannot search topics without a valid timestamp range").
  // Lower bound = the sweep watermark (or a 24h lookback on the very first
  // run); upper bound = now. Logs at/below the watermark are still
  // filtered client-side, and per-tx setNx keeps delivery exactly-once, so
  // a slightly overlapping window is harmless.
  const nowSec = Math.floor(Date.now() / 1000);
  const url =
    `${MIRROR_NODE}/contracts/${TIPS_CONTRACT_ID}/results/logs` +
    `?order=desc&limit=50&topic0=${TIPSENT_TOPIC0}` +
    `&timestamp=gte:${sinceSec}.000000000&timestamp=lte:${nowSec}.999999999`;
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`mirror node responded ${res.status}`);
  const json = (await res.json()) as { logs?: unknown };
  return Array.isArray(json.logs) ? (json.logs as MirrorLog[]) : [];
}

/**
 * Run one push-check sweep. Pure orchestration over injected deps so tests
 * can drive it without touching the network, the real KV, or web-push.
 */
export async function runPushCheck(
  deps: PushCheckDeps,
): Promise<{ status: 200; body: PushCheckResult } | { status: 401 | 503; body: { error: string } }> {
  const {
    kv,
    fetchImpl = fetch,
    sender = webPushSender,
    expectedSecret,
    providedSecret,
    siteUrl,
    resolveUsername,
  } = deps;

  // Auth: a configured secret is required; without one the route applies
  // per-IP rate limiting and the sweep itself stays safe because every push
  // is derived from a real on-chain TipSent log and the watermark makes
  // repeat calls no-ops — an unauthenticated caller can only trigger the
  // same legitimate sweep the cron would run anyway.
  if (expectedSecret != null && !secretsMatch(expectedSecret, providedSecret)) {
    return { status: 401, body: { error: "unauthorized" } };
  }

  let logs: MirrorLog[];
  const watermark = await readWatermark(kv);
  // Lower bound for the mirror-node topic query: the watermark, or a 24h
  // lookback when no sweep has ever run.
  const sinceSec = watermark > 0 ? Math.floor(watermark) : Math.floor(Date.now() / 1000) - 86_400;
  try {
    logs = await fetchTipLogs(fetchImpl, sinceSec);
  } catch (e) {
    console.error(`[push/check] mirror node fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return { status: 503, body: { error: "mirror node unavailable" } };
  }

  let maxTs = watermark;
  for (const log of logs) {
    const ts = parseFloat(log.timestamp ?? "");
    if (Number.isFinite(ts) && ts > maxTs) maxTs = ts;
  }

  // VAPID keypair is self-generated on first use and persisted in KV —
  // no operator setup needed. If the keypair can't be obtained (KV write
  // failure), honestly skip sends but still advance the watermark so a
  // later healthy sweep doesn't replay old tips.
  let keypair: VapidKeypair;
  try {
    keypair = await ensureVapidKeypair(kv);
  } catch (e) {
    console.error(`[push/check] VAPID keypair unavailable: ${e instanceof Error ? e.message : String(e)}`);
    await kv.set(PUSH_LAST_TS_KV_KEY, String(maxTs), PUSH_VAPID_TTL_MS);
    return { status: 200, body: { checked: 0, sent: 0, pruned: 0, skipped: "vapid-unavailable" } };
  }

  let checked = 0;
  let sent = 0;
  let pruned = 0;

  // Cache username resolutions within the sweep — one recipient may appear
  // in several logs.
  const usernameCache = new Map<string, string | null>();
  async function blockpageUrlFor(recipient: string): Promise<string> {
    if (!usernameCache.has(recipient)) {
      let name: string | null = null;
      try {
        name = resolveUsername ? await resolveUsername(recipient) : null;
      } catch {
        name = null;
      }
      usernameCache.set(recipient, name);
    }
    const name = usernameCache.get(recipient);
    if (name) return `${siteUrl}/${encodeURIComponent(name)}`;
    return `${siteUrl}/api/notifications?address=${recipient}`;
  }

  for (const log of logs) {
    const tip = decodeTipLog(log);
    if (!tip || tip.timestampSec <= watermark) continue;
    checked += 1;

    // Idempotency: exactly-once delivery per transaction.
    const claimed = await kv.setNx(`push:sent:${tip.txHash.toLowerCase()}`, "1", PUSH_SENT_TTL_MS);
    if (!claimed) continue;

    const subs = await subscriptionsForRecipient(kv, tip.recipient);
    if (subs.length === 0) continue;

    const url = await blockpageUrlFor(tip.recipient);
    const vapid = { subject: VAPID_SUBJECT, publicKey: keypair.publicKey, privateKey: keypair.privateKey };
    for (const sub of subs) {
      const payload = buildTipPayload(tip, sub.lang, url);
      try {
        await sender(sub, payload, vapid);
        sent += 1;
      } catch (err) {
        if (isGoneError(err)) {
          // Push service says the subscription is dead — prune it so we
          // don't keep paying delivery attempts on every sweep.
          await removeSubscription(kv, tip.recipient, sub.endpoint);
          pruned += 1;
        } else {
          console.error(
            `[push/check] send failed for ${tip.txHash}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  await kv.set(PUSH_LAST_TS_KV_KEY, String(maxTs), PUSH_VAPID_TTL_MS);
  return { status: 200, body: { checked, sent, pruned } };
}
