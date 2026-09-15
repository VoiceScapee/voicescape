/**
 * Blockpage Buddy — chat/build metering, dapp-native port (2026-09-15).
 *
 * Brandon's pricing (same constants as the Agent Kit ops runtime):
 *   Chat:  5 free messages per session, then 5 HBAR per 50 messages.
 *   Build: 5 HBAR flat per custom blockpage build (chat freebies don't apply).
 *
 * Payment = a 5 HBAR tipPage("forge") call on the Tips contract
 * (0.0.10854060). The contract splits it atomically on-chain: 98% to
 * Buddy's wallet, 2% to Brandon's treasury (0.0.10424063). No new money
 * code anywhere — this module only READS the chain to confirm payment.
 *
 * Ported from the audited ops runtime
 * (~/workspace/ops/buddy-agentkit/src/metering.ts + memory.ts) onto the
 * dapp's EXISTING shared KvStore (frontend/lib/server/store.ts), which is
 * the same Upstash DB the website quotas already use. Key design:
 *
 *   buddy:session:<sanitized>   session blob JSON {v, freeUsed, payments,
 *                               consumed, turns}, 7d TTL. Fresh sessions for
 *                               the dapp — the dapp never had Buddy
 *                               metering, so no migration is needed.
 *   buddy:payclaim:<paymentId>  atomic claim-or-reject (setNx, 7d): exactly
 *                               ONE caller credits an on-chain payment,
 *                               across ALL serverless instances.
 *   buddy:payspend:<paymentId>  atomic claim-or-reject (setNx, 7d): one
 *                               payment buys chat XOR build, never both.
 *   buddy:payleft:<paymentId>    COUNT-UP message counter (incr). A take
 *                               succeeds iff the new count <= 50. Over-limit
 *                               takes just keep failing — no decr, no
 *                               restore, no second-spend possible.
 *   buddy:seslock:<sessionId>   best-effort blob-save serializer (setNx,
 *                               owner token, 15s TTL, get-compare-del
 *                               release). Money-critical ops (claims,
 *                               counters) are already atomic via setNx/incr,
 *                               so the lock only guards cache consistency —
 *                               if it can't be acquired the mutation still
 *                               runs, degraded. This fixes the audited
 *                               Upstash lock concern: the old ops design
 *                               (15s claim, no release, 5s spin then
 *                               unlocked write) is replaced by an
 *                               owner-token lock with explicit release.
 *
 * Fail-closed: KvStore transport errors THROW (see store.ts). A quota that
 * cannot be checked must not silently become unlimited — callers answer
 * 503 instead. checkChatAccess throwing = "metering unavailable", never
 * "metering passed".
 *
 * Session ids in the dapp: `wallet-<evm-address-lowercased>` for signed-in
 * users, `anon` for anonymous visitors. (The ops runtime used the bare
 * wallet id; `:` is not allowed by sanitizeSessionId, hence the dash.)
 *
 * No operator bypass is ported: every dapp session meters, including
 * Brandon's. The ops BUDDY_OPERATOR=1 escape hatch existed for CLI
 * testing only and would be an abuse vector in production.
 *
 * Hedera-native only: payment discovery is plain mirror-node REST.
 * Secrets: Upstash keys come from env via getKvStore() — this module never
 * touches raw values and never logs them.
 */

import { keccak256, toUtf8Bytes } from "ethers";
import { getKvStore, type KvStore } from "@/lib/server/store";

export const FREE_MESSAGES = 5;
export const CHAT_PRICE_TINYBAR = 500_000_000; // 5 HBAR
export const CHAT_MESSAGES_PER_PAYMENT = 50;
export const BUILD_PRICE_TINYBAR = 500_000_000; // 5 HBAR
export const BUDDY_USERNAME = "forge";
export const TIPS_ID = "0.0.10854060";

const MIRROR = "https://mainnet.mirrornode.hedera.com/api/v1";
const WEI_PER_TINYBAR = 10_000_000_000n;
const MIN_PAYMENT_WEI = BigInt(CHAT_PRICE_TINYBAR) * WEI_PER_TINYBAR; // 5 HBAR in wei

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d, matches the app session
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d, matches the session lifetime
const LOCK_TTL_MS = 15_000; // 15s owner-token session lock

const SESSION_PREFIX = "buddy:session:";
const PAY_CLAIM_PREFIX = "buddy:payclaim:"; // credit: one winner adds the payment
const PAY_SPEND_PREFIX = "buddy:payspend:"; // first use: one winner assigns chat|build
const PAY_LEFT_PREFIX = "buddy:payleft:"; // count-up message counter
const SES_LOCK_PREFIX = "buddy:seslock:";

/** One 5-HBAR payment (verified on-chain via TipSent logs for "forge"). */
export interface ChatPayment {
  id: string;
  /** Decided by first use: "chat" unlocks 50 messages, "build" pays for one build. */
  kind: null | "chat" | "build";
  /** Cached display value; the buddy:payleft: counter is the source of truth. */
  messagesLeft: number;
}

export interface Turn {
  role: "human" | "ai";
  text: string;
}

export interface SessionBlob {
  v: 1;
  freeUsed: number;
  payments: ChatPayment[];
  /** Payment ids already discovered, so the mirror scan skips them. */
  consumed: string[];
  /** Last exchanges, oldest first (capped — see session.ts). */
  turns: Turn[];
}

export type ChatAccess =
  | { allowed: true; kind: "free" | "paid"; left: number }
  | { allowed: false; freeUsed: number };

export type BuildAccess = { allowed: true } | { allowed: false; reason: string };

/** Session ids come from auth state — sanitize so they can never escape the key. */
export function sanitizeSessionId(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(s)) return s;
  return "local";
}

function keyFor(prefix: string, id: string): string {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("[buddy] key id must be a non-empty string");
  }
  return `${prefix}${encodeURIComponent(id)}`;
}

function blankBlob(): SessionBlob {
  return { v: 1, freeUsed: 0, payments: [], consumed: [], turns: [] };
}

function normalizeBlob(raw: unknown): SessionBlob {
  const blob = blankBlob();
  if (raw === null || typeof raw !== "object") return blob;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.turns)) {
    blob.turns = (r.turns as Turn[]).filter(
      (t) => t && (t.role === "human" || t.role === "ai") && typeof t.text === "string",
    );
  }
  if (typeof r.freeUsed === "number" && r.freeUsed >= 0) {
    blob.freeUsed = Math.floor(r.freeUsed);
  }
  if (Array.isArray(r.payments)) {
    blob.payments = (r.payments as ChatPayment[]).filter(
      (p) =>
        p &&
        typeof p.id === "string" &&
        p.id.length > 0 &&
        (p.kind === null || p.kind === "chat" || p.kind === "build"),
    );
  }
  if (Array.isArray(r.consumed)) {
    blob.consumed = (r.consumed as unknown[]).filter(
      (c): c is string => typeof c === "string",
    );
  }
  return blob;
}

export async function loadRecord(
  sessionId: string,
  store: KvStore = getKvStore(),
): Promise<SessionBlob> {
  const raw = await store.get(keyFor(SESSION_PREFIX, sanitizeSessionId(sessionId)));
  if (!raw) return blankBlob();
  try {
    return normalizeBlob(JSON.parse(raw));
  } catch {
    return blankBlob();
  }
}

export async function saveRecord(
  sessionId: string,
  blob: SessionBlob,
  store: KvStore = getKvStore(),
): Promise<void> {
  blob.v = 1;
  await store.set(
    keyFor(SESSION_PREFIX, sanitizeSessionId(sessionId)),
    JSON.stringify(blob),
    SESSION_TTL_MS,
  );
}

/**
 * Best-effort per-session mutation serializer. Money-critical ops (payment
 * claims, message counters) are atomic via setNx/incr regardless of this
 * lock — it only keeps read-modify-write blob saves from clobbering each
 * other (lost-update on freeUsed / turns / payment merges). If the lock
 * can't be acquired, the mutation still runs: degraded cache consistency,
 * never a double-spend.
 */
export async function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
  store: KvStore = getKvStore(),
): Promise<T> {
  const lockKey = keyFor(SES_LOCK_PREFIX, sanitizeSessionId(sessionId));
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let held = false;
  try {
    held = await store.setNx(lockKey, token, LOCK_TTL_MS);
  } catch {
    held = false;
  }
  if (!held) return await fn(); // degraded: claims/counters still guard exactly-once
  try {
    return await fn();
  } finally {
    try {
      // Release only our own lock — never a successor's.
      const cur = await store.get(lockKey);
      if (cur === token) await store.del(lockKey);
    } catch {
      // The TTL releases it.
    }
  }
}

/**
 * Credit-claim: true only for the first caller to credit this on-chain
 * payment. Atomic across all serverless instances (SET NX). Throws on
 * empty payment id / invalid TTL — never silently succeeds.
 */
export async function claimPaymentCredit(
  paymentId: string,
  store: KvStore = getKvStore(),
  ttlMs: number = CLAIM_TTL_MS,
): Promise<boolean> {
  return store.setNx(keyFor(PAY_CLAIM_PREFIX, paymentId), "1", ttlMs);
}

/**
 * Spend-claim: true only for the first caller to decide this payment's
 * kind (chat credits vs one build). Stops one payment buying both 50
 * messages AND a build when chat and build race.
 */
export async function claimPaymentSpend(
  paymentId: string,
  store: KvStore = getKvStore(),
  ttlMs: number = CLAIM_TTL_MS,
): Promise<boolean> {
  return store.setNx(keyFor(PAY_SPEND_PREFIX, paymentId), "1", ttlMs);
}

/**
 * Atomically take one message unit from a chat payment. Count-up design:
 * the take succeeds iff the new count is within the 50-unit allowance.
 * Over-limit takes fail without consuming anything — no decr, no restore.
 * Exactly 50 takes can ever succeed per payment, across all instances.
 */
export async function takeChatUnit(
  paymentId: string,
  store: KvStore = getKvStore(),
  ttlMs: number = CLAIM_TTL_MS,
): Promise<boolean> {
  const count = await store.incr(keyFor(PAY_LEFT_PREFIX, paymentId), ttlMs);
  return count >= 1 && count <= CHAT_MESSAGES_PER_PAYMENT;
}

/**
 * Remaining messages on a chat payment. The count-up counter is the source
 * of truth; the blob's messagesLeft is only a cached display value.
 */
export async function chatMessagesLeft(
  paymentId: string,
  store: KvStore = getKvStore(),
): Promise<number> {
  const raw = await store.get(keyFor(PAY_LEFT_PREFIX, paymentId));
  const taken = raw === null ? 0 : Number(raw);
  if (!Number.isSafeInteger(taken) || taken < 0) return 0; // corrupt: fail closed
  return CHAT_MESSAGES_PER_PAYMENT - Math.min(CHAT_MESSAGES_PER_PAYMENT, taken);
}

function topic0TipSent(): string {
  return keccak256(toUtf8Bytes("TipSent(string,address,address,uint256,uint256)"));
}
function topic1Forge(): string {
  return keccak256(toUtf8Bytes(BUDDY_USERNAME));
}

/** The dapp session carries the canonical 0x address; the ops CLI used 0.0.x. Accept both. */
async function payerEvmAddress(payer: string): Promise<string | null> {
  if (/^0x[0-9a-fA-F]{40}$/.test(payer)) return payer.toLowerCase();
  if (/^0\.0\.\d+$/.test(payer)) {
    try {
      const res = await fetch(`${MIRROR}/accounts/${payer}`);
      if (!res.ok) return null;
      const acct = (await res.json()) as { evm_address?: string };
      return acct.evm_address ? acct.evm_address.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Find fresh 5-HBAR tipPage("forge") payments from this payer by reading
 * the Tips contract's TipSent logs on the official mirror node. Returns
 * payment ids (log timestamp + index) not already in `consumed`.
 * Read-only: no keys, no signing, no spending. Mirror hiccups return []
 * ("no new payments found"), never "paid".
 */
export async function discoverPayments(
  payer: string,
  consumed: string[],
): Promise<string[]> {
  const evm = await payerEvmAddress(payer);
  if (!evm) return [];
  try {
    const topic2 = "0x" + evm.slice(2).padStart(64, "0");
    const url =
      `${MIRROR}/contracts/${TIPS_ID}/results/logs` +
      `?topic0=${topic0TipSent()}&topic1=${topic1Forge()}&topic2=${topic2}` +
      `&order=desc&limit=50`;
    const logsRes = await fetch(url);
    if (!logsRes.ok) return [];
    const body = (await logsRes.json()) as {
      logs?: Array<{ data?: string; timestamp?: string; transaction_index?: number }>;
    };
    const fresh: string[] = [];
    for (const log of body.logs ?? []) {
      const id = `${log.timestamp ?? "?"}-${log.transaction_index ?? "?"}`;
      if (consumed.includes(id)) continue;
      // data = abi(amount uint256, fee uint256); amount is total tipped (wei)
      const data = log.data ?? "";
      if (data.length < 66) continue;
      let amount = 0n;
      try {
        amount = BigInt("0x" + data.slice(2, 66));
      } catch {
        continue;
      }
      if (amount >= MIN_PAYMENT_WEI) fresh.push(id);
    }
    return fresh;
  } catch {
    return [];
  }
}

/**
 * Record a won payment in the session blob (the winner's half of
 * creditFreshPayments, without chain discovery — for tests and for future
 * wiring that credits payments from another verified source). Returns
 * false when another caller already claimed the credit.
 */
export async function creditPayment(
  sessionId: string,
  paymentId: string,
  store: KvStore = getKvStore(),
): Promise<boolean> {
  const sid = sanitizeSessionId(sessionId);
  if (!(await claimPaymentCredit(paymentId, store))) return false;
  await withSessionLock(
    sid,
    async () => {
      const latest = await loadRecord(sid, store);
      if (!latest.consumed.includes(paymentId)) latest.consumed.push(paymentId);
      if (!latest.payments.some((p) => p.id === paymentId)) {
        latest.payments.push({ id: paymentId, kind: null, messagesLeft: 0 });
      }
      await saveRecord(sid, latest, store);
    },
    store,
  );
  return true;
}

/**
 * Credit any fresh on-chain payments into the session record.
 *
 * Exactly-once across concurrent requests AND instances:
 *  - The atomic credit-claim (setNx) guarantees only one caller wins each
 *    payment id — no payment is ever credited twice.
 *  - Winners merge into the LATEST blob (union by payment id) instead of
 *    saving the stale copy the call started from, so concurrent winners
 *    commute and never clobber each other.
 *  - Nothing is saved when nothing was won.
 */
async function creditFreshPayments(
  sessionId: string,
  payer: string,
  store: KvStore,
): Promise<boolean> {
  const sid = sanitizeSessionId(sessionId);
  // Discovery (slow mirror-node fetch) runs outside the lock; the
  // claim + merge below run inside it.
  const probe = await loadRecord(sid, store);
  const fresh = await discoverPayments(payer, probe.consumed);
  if (fresh.length === 0) return false;
  return withSessionLock(
    sid,
    async () => {
      const latest = await loadRecord(sid, store);
      const won: string[] = [];
      for (const id of fresh) {
        // Skip ids already in this record (a previous attempt may have
        // saved the record but lost the response).
        if (latest.consumed.includes(id) || latest.payments.some((p) => p.id === id)) {
          continue;
        }
        // Atomic exactly-once: only the claim winner credits this payment.
        // Losers skip — the winner's merge below lands the single credit.
        // A lost claim also skips: the payment stays undiscovered and is
        // retried on a later request. Never credit twice.
        if (await claimPaymentCredit(id, store)) won.push(id);
      }
      if (won.length === 0) return false;
      for (const id of won) {
        if (!latest.consumed.includes(id)) latest.consumed.push(id);
        if (!latest.payments.some((p) => p.id === id)) {
          latest.payments.push({ id, kind: null, messagesLeft: 0 });
        }
      }
      await saveRecord(sid, latest, store);
      return true;
    },
    store,
  );
}

async function findActiveChatPayment(
  rec: SessionBlob,
  store: KvStore,
): Promise<ChatPayment | null> {
  for (const p of rec.payments) {
    if (p.kind === "chat" && (await chatMessagesLeft(p.id, store)) > 0) return p;
  }
  return null;
}

/**
 * Can this session chat right now? Checks free allowance, then paid
 * credits, then the chain for fresh payments (when a payer is known).
 *
 * THROWS when the store is unreachable — the caller must fail closed
 * (503), never treat it as "allowed".
 */
export async function checkChatAccess(
  sessionId: string,
  payer?: string,
  store: KvStore = getKvStore(),
): Promise<ChatAccess> {
  const sid = sanitizeSessionId(sessionId);
  const rec = await loadRecord(sid, store);
  if (rec.freeUsed < FREE_MESSAGES) {
    return { allowed: true, kind: "free", left: FREE_MESSAGES - rec.freeUsed };
  }
  const active = await findActiveChatPayment(rec, store);
  if (active) {
    return { allowed: true, kind: "paid", left: await chatMessagesLeft(active.id, store) };
  }
  // An unused payment becomes chat credit on first use — but first use is
  // a race (a build may claim the same payment concurrently), so the kind
  // assignment goes through the atomic spend claim.
  const unused = rec.payments.find((p) => p.kind === null);
  if (unused) {
    // The kind assignment runs under the session lock: the load, the
    // atomic spend-claim, and the save are one serialized unit, so a
    // concurrent credit-merge or build-spend can't clobber it.
    const assigned = await withSessionLock(
      sid,
      async () => {
        const latest = await loadRecord(sid, store);
        const p = latest.payments.find((x) => x.id === unused.id);
        if (!p || p.kind !== null) return false;
        if (!(await claimPaymentSpend(p.id, store))) return false;
        p.kind = "chat";
        p.messagesLeft = CHAT_MESSAGES_PER_PAYMENT;
        await saveRecord(sid, latest, store);
        return true;
      },
      store,
    );
    if (assigned) {
      return { allowed: true, kind: "paid", left: CHAT_MESSAGES_PER_PAYMENT };
    }
    // Lost the first-use race (or the payment is gone). Reload: follow
    // whatever the winner decided rather than spending the payment twice.
    const latest = await loadRecord(sid, store);
    const decided = latest.payments.find((p) => p.id === unused.id);
    if (decided && decided.kind === "chat" && (await chatMessagesLeft(decided.id, store)) > 0) {
      return { allowed: true, kind: "paid", left: await chatMessagesLeft(decided.id, store) };
    }
    // Spent on a build, or the winner hasn't landed its save yet. Fail
    // closed: the payment is never spent twice, the user just retries.
    return { allowed: false, freeUsed: latest.freeUsed };
  }
  // Last resort: look for fresh on-chain payments (needs a payer).
  // creditFreshPayments saves only when it won a credit — no stale writes.
  if (payer && (await creditFreshPayments(sid, payer, store))) {
    return checkChatAccess(sid, payer, store);
  }
  return { allowed: false, freeUsed: rec.freeUsed };
}

/**
 * Record one answered chat message against the free allowance or paid
 * credits. The counter take is atomic; the blob cache sync runs under the
 * session lock so concurrent messages can't lost-update it.
 *
 * Edge case (bounded): if two requests race the very last unit, both may
 * have passed checkChatAccess — the counter still grants exactly 50 takes
 * total, so at most a couple of messages go unmetered at the exhaustion
 * boundary. Never a double-spend.
 */
export async function noteChatMessage(
  sessionId: string,
  kind: "free" | "paid",
  store: KvStore = getKvStore(),
): Promise<void> {
  const sid = sanitizeSessionId(sessionId);
  await withSessionLock(
    sid,
    async () => {
      const rec = await loadRecord(sid, store);
      if (kind === "free") {
        rec.freeUsed += 1;
      } else {
        const p = await findActiveChatPayment(rec, store);
        if (p) {
          p.messagesLeft = (await takeChatUnit(p.id, store))
            ? await chatMessagesLeft(p.id, store)
            : 0;
        }
      }
      await saveRecord(sid, rec, store);
    },
    store,
  );
}

/**
 * Can this session start a custom blockpage build? Builds always cost
 * 5 HBAR — the free messages cover chat only. Consumes one unused
 * on-chain payment. (Not yet wired to a dapp route — the chat widget is
 * chat-only. Ported so the chat/build first-use race stays exactly-once
 * when build wiring lands.)
 */
export async function checkBuildAccess(
  sessionId: string,
  payer?: string,
  store: KvStore = getKvStore(),
): Promise<BuildAccess> {
  const sid = sanitizeSessionId(sessionId);
  const rec = await loadRecord(sid, store);
  if (rec.payments.some((p) => p.kind === null)) return { allowed: true };
  // creditFreshPayments saves only when it won a credit — no stale writes.
  if (payer && (await creditFreshPayments(sid, payer, store))) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      "A custom blockpage build is 5 HBAR. Tip 5 HBAR to the 'forge' page " +
      "in the app and I'll start building the moment it settles on-chain.",
  };
}

/**
 * Mark one unused payment as spent on a build. Resolves true when THIS
 * call spent a payment, false when none was available (or a concurrent
 * build won the race for the last one). Failed drafts never reach this —
 * the caller only invokes it after the draft validates.
 */
export async function consumeBuild(
  sessionId: string,
  store: KvStore = getKvStore(),
): Promise<boolean> {
  const sid = sanitizeSessionId(sessionId);
  // Under the session lock: the load, the atomic spend-claim, and the save
  // are one serialized unit. The retry loop covers the case where the
  // spend-claim for one payment was already won elsewhere (e.g. a chat
  // took it) — another unused payment may still be available.
  return withSessionLock(
    sid,
    async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const rec = await loadRecord(sid, store);
        const p = rec.payments.find((x) => x.kind === null);
        if (!p) return false;
        if (await claimPaymentSpend(p.id, store)) {
          p.kind = "build";
          await saveRecord(sid, rec, store);
          return true;
        }
      }
      return false;
    },
    store,
  );
}

/**
 * @param publicMode true for anonymous visitors (no wallet to tip from):
 * the wall points at connecting a wallet instead of demanding the
 * impossible.
 */
export function paywallMessage(publicMode: boolean): string {
  if (publicMode) {
    return (
      "You've used your 5 free messages here. To keep chatting, connect " +
      "your wallet in the app — 5 HBAR unlocks 50 more messages."
    );
  }
  return (
    "You've used your 5 free messages. Tip 5 HBAR to my 'forge' page in " +
    "the app to unlock 50 more messages — I check on-chain, so the moment " +
    "it settles I'll pick up right where we left off. (A full custom " +
    "blockpage build is also 5 HBAR.)"
  );
}
