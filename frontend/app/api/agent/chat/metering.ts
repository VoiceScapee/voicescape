/**
 * Dapp-side metering for Buddy: chat paywall + 5-HBAR build entitlement.
 *
 * Brandon's pricing (2026-09-15, refined 2026-09-16):
 *  - Answering Voicescape / blockchain questions is FREE — always.
 *  - Everything else (general chat): 5 free messages per identity, then
 *    5 HBAR per 50 messages.
 *  - A custom blockpage build is 5 HBAR flat. Free messages cover chat
 *    only; the turn that generates the build is covered by the build
 *    payment itself (no chat check on that turn).
 *
 * Payment = a tipPage("forge") tip on the existing Tips contract
 * (0.0.10854060 — atomic 98/2 split on-chain, no new money code). This
 * module only READS the chain: it finds the tip in the contract's TipSent
 * logs on the official mirror node and tracks spent/unspent payments in
 * the shared store. Buddy never signs, spends, or publishes.
 *
 * Semantics mirror the ops agentkit metering on purpose:
 *  - One payment = 50 chat messages OR one build. First use decides the
 *    kind; a payment can never buy both.
 *  - The build credit is consumed only AFTER the draft validates — a
 *    failed draft never eats the payment.
 *  - Atomic claims (store setNx) make credit + spend exactly-once, even
 *    when two requests race for the last payment.
 *  - The claim keys (buddy:payclaim: / buddy:payspend:) are IDENTICAL to
 *    the agentkit's, so when both runtimes share Upstash, a payment spent
 *    in one can never be spent again in the other. Paid message units are
 *    counted with an atomic counter per payment, so concurrent requests
 *    can never spend the same unit twice.
 *  - Ledger read-modify-write runs under a short store lock (same shape
 *    as the agentkit's withSessionLock); the claims/counters are what
 *    guarantee exactly-once even if the lock degrades.
 *  - BUDDY_OPERATOR=1 bypasses metering (ops testing only — production
 *    widget sessions never set it).
 *
 * Store failures throw (fail closed): the route answers 503 instead of
 * handing out chat or a build it can't account for. Until the Upstash pair
 * lands in Vercel, the store is per-instance in-memory (documented caveat
 * in lib/server/store.ts) — exactly-once then holds per instance.
 */
import { keccak256, toUtf8Bytes } from "ethers";
import { randomUUID } from "crypto";

import { getKvStore, type KvStore } from "@/lib/server/store";
import { isValidPage, type VoicescapePage } from "@/lib/schema";

export const CHAT_PRICE_TINYBAR = 500_000_000; // 5 HBAR
export const BUILD_PRICE_TINYBAR = 500_000_000; // 5 HBAR
export const FREE_MESSAGES = 5;
export const CHAT_MESSAGES_PER_PAYMENT = 50;
/**
 * Free visual-mock previews per build (Brandon's 2026-09-16 spec): after
 * the username/bio/vibe are collected, the visitor sees up to 2 free
 * visual mocks BEFORE any paywall. Mocks are pure model output with
 * placeholder art — no image generation, so they cost ~$0.001 each.
 * Counted per identity + build username; a paid build resets the count
 * so a brand-new build repeats the whole process.
 */
export const MAX_FREE_PREVIEWS = 2;

const BUDDY_USERNAME = "forge";
const TIPS_CONTRACT_ID = "0.0.10854060";
const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";
const WEI_PER_TINYBAR = 10_000_000_000n;
// TipSent `amount` is denominated in tinybars on Hedera (the EVM value
// unit is the tinybar: a 5-HBAR tipPage logs amount=500_000_000, verified
// 2026-09-16 against mainnet). Do NOT scale by WEI_PER_TINYBAR here —
// doing so sets the bar at 5e18 and no real payment is ever credited.
const MIN_PAYMENT_TINYBAR = BigInt(CHAT_PRICE_TINYBAR); // 5 HBAR in tinybars

// Atomic claim keys — identical to the ops agentkit metering.
const PAY_CLAIM_PREFIX = "buddy:payclaim:"; // credit: one winner records the payment
const PAY_SPEND_PREFIX = "buddy:payspend:"; // spend: one winner assigns the payment's kind
// Session ledger keys. Wallets key by EVM address (what the dapp session
// token carries); anonymous visitors key by IP (they can never pay
// on-chain, so their ledger only ever tracks free usage).
const LEDGER_PREFIX = "buddy:chat:";
const ANON_LEDGER_PREFIX = "buddy:chat:anon:";
// Paid message units: atomic counter per payment, counts UP from zero.
// A take succeeds iff the new value is <= 50, so exactly 50 takes can ever
// succeed no matter how requests interleave.
const PAY_USED_PREFIX = "buddy:dapp:payused:";
// Ledger mutation lock (same shape as the agentkit's withSessionLock).
const LOCK_PREFIX = "buddy:lock:";
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches the app session
const LOCK_TTL_MS = 15_000;
const LOCK_SPIN_MS = 5_000;

// ---------------------------------------------------------------------------
// Topic classification: Voicescape / blockchain Q&A is always free.
// ---------------------------------------------------------------------------

/** Domain keywords — generous on purpose: when in doubt, it's free. */
const ON_TOPIC_RES = [
  /voicescape/i,
  /block-?pages?/i,
  /\bbuddy\b/i,
  /hedera/i,
  /\bhbar\b/i,
  /hashgraph/i,
  /blockchain/i,
  /\bcrypto\b/i,
  /web3/i,
  /\bdapp\b/i,
  /\bwallets?\b/i,
  /\bnfts?\b/i,
  /tokens?/i,
  /defi/i,
  /treasury/i,
  /airdrop/i,
  /publish/i,
  /builders?/i,
  /\bbuild\b/i,
  /forge/i,
  /\btips?\b/i,
  /usernames?/i,
  /\bbio\b/i,
  /cost|price|pricing|fees?|pay/i,
  /my\s+(page|profile|site|account)/i,
  // Page-editing vocabulary (build revisions are product questions).
  /background|colou?r|font|layout|theme|images?|pictures?|songs?|music/i,
];

/** Bare greetings / acknowledgments are part of the support conversation. */
const CONVERSATIONAL_RE =
  /^(hi|hey|hello|yo|thanks|thank\s?you|thx|ty|bye|goodbye|ok|okay|sure|yes|no|nope|please|welcome|great|cool|nice|awesome|got it|i see)\s*[.!?]*$/i;

/**
 * True when this message is a Voicescape / blockchain question (always
 * free) as opposed to general chat (metered). The caller also treats an
 * in-progress build flow as on-topic; this covers the message text only.
 */
export function isOnTopicMessage(message: string): boolean {
  const text = (message ?? "").trim();
  if (!text) return true;
  if (CONVERSATIONAL_RE.test(text)) return true;
  return ON_TOPIC_RES.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Paywall copy
// ---------------------------------------------------------------------------

export const BUILD_PAYWALL_ANON =
  "A custom blockpage build is 5 HBAR, and builds need a connected wallet. " +
  "Connect your wallet (top-right), then tip 5 HBAR to my 'forge' page — " +
  'then say "go" here and I\'ll start building.';

export const BUILD_PAYWALL_UNPAID =
  "A custom blockpage build is 5 HBAR. Tip 5 HBAR to my 'forge' page in " +
  'the app, then say "go" here and I\'ll start building.';

export const BUILD_RACE_MESSAGE =
  "Your 5 HBAR build payment was just used by another request — nothing " +
  "was charged twice. Please run the build again.";

export const BUILD_FINALIZE_ERROR =
  "I couldn't finalize your build payment just now — nothing was charged. " +
  "Please try again in a bit.";

export const BUILD_STORE_ERROR =
  "I can't check build payments right now — try again in a bit. Nothing was charged.";

export const CHAT_PAYWALL_ANON =
  "You've used your 5 free messages. Questions about Voicescape and " +
  "blockchain are always free — to keep chatting about anything else, " +
  "connect your wallet: 5 HBAR unlocks 50 more messages.";

export const CHAT_PAYWALL_WALLET =
  "You've used your 5 free messages. Questions about Voicescape and " +
  "blockchain are always free — for everything else, tip 5 HBAR to my " +
  "'forge' page and I'll unlock 50 more messages as soon as it settles " +
  "on-chain. (A custom blockpage build is also 5 HBAR.)";

export const CHAT_METER_ERROR =
  "I can't check the chat meter right now — try again in a bit.";

/** Operator bypass for Danny's own testing (BUDDY_OPERATOR=1, ops only). */
export function meteringBypass(): boolean {
  return process.env.BUDDY_OPERATOR === "1";
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type ChatIdentity =
  | { kind: "wallet"; evm: string }
  | { kind: "anon"; ip: string };

type Payment = {
  id: string;
  /** null = fresh on-chain payment, kind decided by first use. */
  kind: null | "chat" | "build";
  /** Cached paid-message seed; the atomic counter is the source of truth. */
  messagesLeft: number;
};

type Ledger = {
  v: 1;
  /** Off-topic messages served (on-topic Q&A is never counted). */
  freeUsed: number;
  payments: Payment[];
  /** Payment ids already credited — mirror-node discovery dedupe. */
  consumed: string[];
};

function blankLedger(): Ledger {
  return { v: 1, freeUsed: 0, payments: [], consumed: [] };
}

function ledgerKeyFor(identity: ChatIdentity): string {
  return identity.kind === "wallet"
    ? `${LEDGER_PREFIX}${identity.evm.toLowerCase()}`
    : `${ANON_LEDGER_PREFIX}${identity.ip}`;
}

function normalizeLedger(raw: unknown): Ledger {
  const out = blankLedger();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (Number.isSafeInteger(r.freeUsed) && (r.freeUsed as number) >= 0) {
    out.freeUsed = r.freeUsed as number;
  }
  if (Array.isArray(r.payments)) {
    for (const p of r.payments as Array<Record<string, unknown>>) {
      if (
        p &&
        typeof p.id === "string" &&
        (p.kind === null || p.kind === "chat" || p.kind === "build")
      ) {
        out.payments.push({
          id: p.id,
          kind: p.kind,
          messagesLeft:
            typeof p.messagesLeft === "number" && p.messagesLeft >= 0
              ? Math.floor(p.messagesLeft)
              : 0,
        });
      }
    }
  }
  if (Array.isArray(r.consumed)) {
    for (const c of r.consumed as unknown[]) {
      if (typeof c === "string") out.consumed.push(c);
    }
  }
  return out;
}

async function loadLedger(
  store: KvStore,
  identity: ChatIdentity
): Promise<Ledger> {
  const raw = await store.get(ledgerKeyFor(identity));
  if (!raw) return blankLedger();
  try {
    return normalizeLedger(JSON.parse(raw));
  } catch {
    return blankLedger();
  }
}

async function saveLedger(
  store: KvStore,
  identity: ChatIdentity,
  ledger: Ledger
): Promise<void> {
  await store.set(ledgerKeyFor(identity), JSON.stringify(ledger), CLAIM_TTL_MS);
}

/**
 * Serialize a ledger's read-modify-write so concurrent requests can't
 * clobber each other's saves (lost update). Shape mirrors the agentkit's
 * withSessionLock, with one improvement: the lock is released when the
 * holder finishes (token-checked, well inside the TTL), so back-to-back
 * operations on the same ledger don't spin the full 5s retry window. The
 * atomic claims/counters are what guarantee exactly-once spending even if
 * the lock degrades.
 */
async function withLedgerLock<T>(
  store: KvStore,
  identity: ChatIdentity,
  fn: () => Promise<T>
): Promise<T> {
  const lockKey = `${LOCK_PREFIX}${encodeURIComponent(ledgerKeyFor(identity))}`;
  const token = randomUUID();
  const start = Date.now();
  const deadline = start + LOCK_SPIN_MS;
  let acquired = false;
  while (Date.now() < deadline) {
    if (await store.setNx(lockKey, token, LOCK_TTL_MS)) {
      acquired = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    return await fn();
  } finally {
    // Release only while we provably still own the lock (well inside the
    // TTL, token still ours) — never drop a successor's lock.
    if (acquired && Date.now() - start < LOCK_TTL_MS / 2) {
      try {
        if ((await store.get(lockKey)) === token) await store.del(lockKey);
      } catch {
        // Best effort: the TTL frees it anyway.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// On-chain payment discovery (read-only)
// ---------------------------------------------------------------------------

function topic0TipSent(): string {
  return keccak256(toUtf8Bytes("TipSent(string,address,address,uint256,uint256)"));
}
function topic1Forge(): string {
  return keccak256(toUtf8Bytes(BUDDY_USERNAME));
}

/**
 * The EVM address a Hedera wallet actually uses as msg.sender.
 *
 * Sessions canonicalize 0.0.x accounts to the long-zero form
 * (0x0000...<num>), but a wallet with an ECDSA key calls contracts from
 * its KEY-DERIVED 0x address — and TipSent logs msg.sender as that
 * key-derived address. Filtering logs by the long-zero form matches
 * nothing, so no payment is ever discovered. Resolve via the official
 * mirror node; fall back to the input on any hiccup (fail-closed: a
 * wrong filter finds no payments, never a false credit).
 */
async function resolveSenderEvmAddress(evmAddress: string): Promise<string> {
  const m = /^0x0{24}([0-9a-fA-F]{16})$/.exec(evmAddress.trim());
  if (!m) return evmAddress.toLowerCase();
  const accountId = `0.0.${BigInt("0x" + m[1]).toString()}`;
  try {
    const res = await fetch(`${MIRROR_BASE}/accounts/${accountId}`);
    if (!res.ok) return evmAddress.toLowerCase();
    const body = (await res.json()) as { evm_address?: string };
    return typeof body.evm_address === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.evm_address)
      ? body.evm_address.toLowerCase()
      : evmAddress.toLowerCase();
  } catch {
    return evmAddress.toLowerCase();
  }
}

/**
 * Find fresh 5-HBAR tipPage("forge") payments from this wallet by reading
 * the Tips contract's TipSent logs on the official mirror node. Returns
 * payment ids (`<consensusTimestamp>-<txIndex>`, unique per on-chain
 * payment) not already credited. Read-only; a mirror-node hiccup resolves
 * to "no new payments" — never to paid.
 */
async function discoverFreshPayments(
  evmAddress: string,
  knownIds: string[]
): Promise<string[]> {
  try {
    const sender = await resolveSenderEvmAddress(evmAddress);
    const topic2 = "0x" + sender.slice(2).toLowerCase().padStart(64, "0");
    // Mirror node REQUIRES a bounded timestamp range (strictly under 7d)
    // for topic searches — verified 2026-09-16 against mainnet: without it
    // the query silently returns zero logs and a paid build would NEVER be
    // credited. The credit poll runs right after payment, so a 6-day window
    // covers the flow with margin under the mirror's hard cap.
    const nowSec = Math.floor(Date.now() / 1000);
    const fromSec = nowSec - 6 * 24 * 3600;
    const url =
      `${MIRROR_BASE}/contracts/${TIPS_CONTRACT_ID}/results/logs` +
      `?topic0=${topic0TipSent()}&topic1=${topic1Forge()}&topic2=${topic2}` +
      `&order=desc&limit=50` +
      `&timestamp=gte:${fromSec}.000000000&timestamp=lte:${nowSec}.999999999`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const body = (await res.json()) as {
      logs?: Array<{
        data?: string;
        timestamp?: string;
        transaction_index?: number;
      }>;
    };
    const fresh: string[] = [];
    for (const log of body.logs ?? []) {
      const id = `${log.timestamp ?? "?"}-${log.transaction_index ?? "?"}`;
      if (knownIds.includes(id)) continue;
      // data = abi(amount uint256, fee uint256); amount is total tipped
      // (tinybars on Hedera — see MIN_PAYMENT_TINYBAR above)
      const data = log.data ?? "";
      if (data.length < 66) continue;
      let amount = 0n;
      try {
        amount = BigInt("0x" + data.slice(2, 66));
      } catch {
        continue;
      }
      if (amount >= MIN_PAYMENT_TINYBAR) fresh.push(id);
    }
    return fresh;
  } catch {
    return [];
  }
}

/**
 * Credit won payments into the ledger (union by payment id — concurrent
 * credit saves commute instead of clobbering). Runs under the ledger lock.
 */
async function creditPayments(
  store: KvStore,
  identity: ChatIdentity,
  ids: string[]
): Promise<boolean> {
  if (identity.kind !== "wallet" || ids.length === 0) return false;
  const evm = identity.evm.toLowerCase();
  return withLedgerLock(store, identity, async () => {
    const ledger = await loadLedger(store, identity);
    let credited = false;
    for (const id of ids) {
      if (
        ledger.consumed.includes(id) ||
        ledger.payments.some((p) => p.id === id)
      ) {
        continue;
      }
      // Atomic exactly-once: only the claim winner credits this payment.
      // Losers skip — the winner's save lands the single credit. A payment
      // whose claim failed stays undiscovered and is retried later.
      if (
        await store.setNx(
          `${PAY_CLAIM_PREFIX}${encodeURIComponent(id)}`,
          evm,
          CLAIM_TTL_MS
        )
      ) {
        ledger.consumed.push(id);
        ledger.payments.push({ id, kind: null, messagesLeft: 0 });
        credited = true;
      }
    }
    if (credited) await saveLedger(store, identity, ledger);
    return credited;
  });
}

// ---------------------------------------------------------------------------
// Paid message units (atomic counter per chat payment)
// ---------------------------------------------------------------------------

function payUsedKey(paymentId: string): string {
  return `${PAY_USED_PREFIX}${encodeURIComponent(paymentId)}`;
}

/** Remaining paid messages on a chat payment (atomic counter). */
async function paidLeft(store: KvStore, paymentId: string): Promise<number> {
  const raw = await store.get(payUsedKey(paymentId));
  const used = raw === null ? 0 : Number(raw);
  const n = Number.isSafeInteger(used) && used >= 0 ? used : 0;
  return Math.max(0, CHAT_MESSAGES_PER_PAYMENT - n);
}

/**
 * Take one paid message unit. Resolves true when a unit was taken — i.e.
 * the atomic counter's new value stayed within the 50-unit budget, so
 * exactly 50 takes can ever succeed no matter how requests interleave.
 */
async function takePaidUnit(
  store: KvStore,
  paymentId: string
): Promise<boolean> {
  const used = await store.incr(payUsedKey(paymentId), CLAIM_TTL_MS);
  return used <= CHAT_MESSAGES_PER_PAYMENT;
}

async function activeChatPayment(
  store: KvStore,
  ledger: Ledger
): Promise<Payment | null> {
  for (const p of ledger.payments) {
    if (p.kind === "chat" && (await paidLeft(store, p.id)) > 0) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chat access
// ---------------------------------------------------------------------------

export type ChatAccess =
  | { allowed: true; kind: "free" | "paid"; left: number }
  | { allowed: false; reason: string };

/**
 * Can this identity send one more off-topic chat message? Checks the free
 * allowance, then paid credits, then assigns a fresh on-chain payment to
 * chat on first use (atomic spend claim — one payment can never buy both
 * chat and a build). Anonymous visitors can never pay on-chain: after the
 * free messages they get the connect-wallet paywall. Throws when the store
 * is unreachable (fail closed).
 */
export async function checkChatAccess(
  identity: ChatIdentity,
  store: KvStore = getKvStore()
): Promise<ChatAccess> {
  if (meteringBypass()) return { allowed: true, kind: "free", left: 999 };
  const paywall =
    identity.kind === "wallet" ? CHAT_PAYWALL_WALLET : CHAT_PAYWALL_ANON;

  for (let round = 0; round < 2; round++) {
    const ledger = await loadLedger(store, identity);
    if (ledger.freeUsed < FREE_MESSAGES) {
      return {
        allowed: true,
        kind: "free",
        left: FREE_MESSAGES - ledger.freeUsed,
      };
    }
    if (identity.kind === "wallet") {
      const active = await activeChatPayment(store, ledger);
      if (active) {
        return {
          allowed: true,
          kind: "paid",
          left: await paidLeft(store, active.id),
        };
      }
      // First use decides the kind: an unused payment becomes chat credit
      // here — but only the spend-claim winner assigns it, so a build
      // racing for the same payment can't both win.
      const unused = ledger.payments.find((p) => p.kind === null);
      if (unused) {
        const assigned = await withLedgerLock(store, identity, async () => {
          const latest = await loadLedger(store, identity);
          const p = latest.payments.find((x) => x.id === unused.id);
          if (!p || p.kind !== null) return false;
          if (
            !(await store.setNx(
              `${PAY_SPEND_PREFIX}${encodeURIComponent(p.id)}`,
              identity.evm.toLowerCase(),
              CLAIM_TTL_MS
            ))
          ) {
            return false;
          }
          p.kind = "chat";
          p.messagesLeft = CHAT_MESSAGES_PER_PAYMENT;
          await saveLedger(store, identity, latest);
          return true;
        });
        if (assigned) {
          return {
            allowed: true,
            kind: "paid",
            left: CHAT_MESSAGES_PER_PAYMENT,
          };
        }
        // Lost the first-use race. Reload: follow whatever the winner
        // decided rather than spending the payment twice.
        const latest = await loadLedger(store, identity);
        const decided = latest.payments.find((x) => x.id === unused.id);
        if (
          decided &&
          decided.kind === "chat" &&
          (await paidLeft(store, decided.id)) > 0
        ) {
          return {
            allowed: true,
            kind: "paid",
            left: await paidLeft(store, decided.id),
          };
        }
        return { allowed: false, reason: paywall };
      }
      // Last resort: look for fresh on-chain payments, credit them, retry.
      const known = [
        ...ledger.payments.map((p) => p.id),
        ...ledger.consumed,
      ];
      const fresh = await discoverFreshPayments(identity.evm, known);
      if (await creditPayments(store, identity, fresh)) continue;
    }
    return { allowed: false, reason: paywall };
  }
  return { allowed: false, reason: paywall };
}

/**
 * Record one answered off-topic message: free allowance increment or one
 * paid unit. Runs after the reply was produced. A store failure here
 * throws — the caller already served the reply, so it catches and moves
 * on (the pre-check above is what fails closed).
 */
export async function noteChatMessage(
  identity: ChatIdentity,
  kind: "free" | "paid",
  store: KvStore = getKvStore()
): Promise<void> {
  if (meteringBypass()) return;
  await withLedgerLock(store, identity, async () => {
    const ledger = await loadLedger(store, identity);
    if (kind === "free") {
      ledger.freeUsed += 1;
    } else {
      const p = await activeChatPayment(store, ledger);
      if (p) await takePaidUnit(store, p.id);
    }
    await saveLedger(store, identity, ledger);
  });
}

// Preview counters: free visual mocks per identity + build username.
// Keyed separately from the payment ledger — previews are free, so they
// never touch payments; the username scope means a brand-new build (new
// username) gets its own 2 previews.
const PREVIEW_PREFIX = "buddy:preview:";
const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches the app session

function previewKeyFor(identity: ChatIdentity, username: string): string {
  const who =
    identity.kind === "wallet"
      ? `wallet:${identity.evm.toLowerCase()}`
      : `anon:${identity.ip}`;
  return `${PREVIEW_PREFIX}${who}:${username.toLowerCase()}`;
}

/**
 * How many free visual-mock previews this identity has used for this
 * build username. Throws when the store is unreachable (fail closed).
 */
export async function getPreviewsUsed(
  identity: ChatIdentity,
  username: string,
  store: KvStore = getKvStore()
): Promise<number> {
  if (meteringBypass()) return 0;
  const raw = await store.get(previewKeyFor(identity, username));
  const n = raw === null ? 0 : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * Record one delivered free preview. Resolves the new total used. Only
 * call after a valid mock was actually delivered — a model glitch that
 * produced no mock must not eat the visitor's allowance. Throws when the
 * store is unreachable (fail closed).
 */
export async function notePreview(
  identity: ChatIdentity,
  username: string,
  store: KvStore = getKvStore()
): Promise<number> {
  if (meteringBypass()) return 0;
  return store.incr(previewKeyFor(identity, username), PREVIEW_TTL_MS);
}

/**
 * Reset the free-preview counters for this identity (all build usernames).
 * Called when a build payment is consumed: the next brand-new build
 * repeats the whole process (2 free previews -> 5 HBAR -> build).
 */
export async function resetBuildPreviews(
  identity: ChatIdentity,
  store: KvStore = getKvStore()
): Promise<void> {
  const who =
    identity.kind === "wallet"
      ? `wallet:${identity.evm.toLowerCase()}`
      : `anon:${identity.ip}`;
  await store.clearPrefix(`${PREVIEW_PREFIX}${who}:`);
}

/**
 * Remember the last delivered free mock for this identity + build username,
 * so a plain-text follow-up ("make the hero bigger") can revise the actual
 * mock even when the widget didn't echo preview_draft. Mocks are free, so
 * this never touches payments. Lives under the preview prefix, so a paid
 * build resets it along with the counters. Validated on read; throws when
 * the store is unreachable (fail closed, like the counters).
 */
const MOCK_KEY_SUFFIX = ":mock";

function mockKeyFor(identity: ChatIdentity, username: string): string {
  return `${previewKeyFor(identity, username)}${MOCK_KEY_SUFFIX}`;
}

export async function saveLastMock(
  identity: ChatIdentity,
  username: string,
  page: VoicescapePage,
  store: KvStore = getKvStore()
): Promise<void> {
  if (meteringBypass()) return;
  await store.set(
    mockKeyFor(identity, username),
    JSON.stringify(page),
    PREVIEW_TTL_MS
  );
}

export async function getLastMock(
  identity: ChatIdentity,
  username: string,
  store: KvStore = getKvStore()
): Promise<VoicescapePage | null> {
  if (meteringBypass()) return null;
  const raw = await store.get(mockKeyFor(identity, username));
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    return isValidPage(data) ? data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build access
// ---------------------------------------------------------------------------

export type BuildAccess =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Can this wallet start a custom blockpage build? Builds always cost
 * 5 HBAR — the free chat messages cover chat only. Credits fresh on-chain
 * payments (exactly-once via the atomic claim) and reports whether an
 * unspent build payment exists. Throws when the store is unreachable
 * (fail closed — the caller must not treat this as paid).
 */
export async function checkBuildAccess(
  evmAddress: string,
  store: KvStore = getKvStore()
): Promise<BuildAccess> {
  if (meteringBypass()) return { allowed: true };
  const identity: ChatIdentity = { kind: "wallet", evm: evmAddress };
  const ledger = await loadLedger(store, identity);
  if (ledger.payments.some((p) => p.kind === null)) return { allowed: true };
  const known = [...ledger.payments.map((p) => p.id), ...ledger.consumed];
  const fresh = await discoverFreshPayments(evmAddress.toLowerCase(), known);
  if (await creditPayments(store, identity, fresh)) {
    const latest = await loadLedger(store, identity);
    if (latest.payments.some((p) => p.kind === null)) return { allowed: true };
  }
  return { allowed: false, reason: BUILD_PAYWALL_UNPAID };
}

/**
 * Has this wallet ever paid for a build — i.e. does it hold an unspent
 * build payment, or has it spent one on a build before? Used for draft
 * refinements ("tweaks"): a tweak revises the already-paid build, so it
 * must not consume another payment — but a wallet that never paid must
 * not get a free build by sending a fabricated refine draft. Throws when
 * the store is unreachable (fail closed).
 */
export async function hasBuildHistory(
  evmAddress: string,
  store: KvStore = getKvStore()
): Promise<boolean> {
  if (meteringBypass()) return true;
  const identity: ChatIdentity = { kind: "wallet", evm: evmAddress };
  const ledger = await loadLedger(store, identity);
  return ledger.payments.some((p) => p.kind === null || p.kind === "build");
}

/**
 * Spend one unused 5-HBAR payment on a build. Resolves true when THIS call
 * spent a payment, false when none was available (or a concurrent build
 * won the race for the last one). Call only after the draft validated —
 * failed drafts never reach this, so they never consume the payment.
 * Throws when the store is unreachable (fail closed).
 */
export async function consumeBuild(
  evmAddress: string,
  store: KvStore = getKvStore()
): Promise<boolean> {
  if (meteringBypass()) return true;
  const identity: ChatIdentity = { kind: "wallet", evm: evmAddress };
  return withLedgerLock(store, identity, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ledger = await loadLedger(store, identity);
      const p = ledger.payments.find((x) => x.kind === null);
      if (!p) return false;
      // Atomic spend claim (global per payment id): the first caller to win
      // assigns this payment to its build. A lost race retries against the
      // next unused payment instead of spending twice.
      if (
        await store.setNx(
          `${PAY_SPEND_PREFIX}${encodeURIComponent(p.id)}`,
          evmAddress.toLowerCase(),
          CLAIM_TTL_MS
        )
      ) {
        p.kind = "build";
        await saveLedger(store, identity, ledger);
        // A paid build resets the free-preview counters: the visitor's
        // next brand-new build repeats the whole process (2 free previews
        // -> 5 HBAR -> build) instead of hitting an exhausted allowance.
        try {
          await resetBuildPreviews(identity, store);
        } catch {
          // Non-fatal: the payment is already spent and recorded. A stale
          // preview counter only affects future free previews, never money.
        }
        return true;
      }
    }
    return false;
  });
}
