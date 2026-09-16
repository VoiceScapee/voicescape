/**
 * Dapp-side 5-HBAR build entitlement for Buddy's custom blockpage flow.
 *
 * Brandon's pricing: a custom blockpage build costs 5 HBAR, paid as a
 * tipPage("forge") tip on the existing Tips contract (0.0.10854060 —
 * atomic 98/2 split on-chain, no new money code). This module only READS
 * the chain: it finds the tip in the contract's TipSent logs on the
 * official mirror node and tracks spent/unspent payments in the shared
 * store. Buddy never signs, spends, or publishes.
 *
 * Semantics mirror the ops agentkit metering (2026-09-15) on purpose:
 *  - One payment = one build. First use decides the kind; a payment can
 *    never buy two builds.
 *  - The build credit is consumed only AFTER the draft validates — a
 *    failed draft never eats the payment.
 *  - Atomic claims (store setNx) make credit + spend exactly-once, even
 *    when two builds race for the last payment.
 *  - The claim keys (buddy:payclaim: / buddy:payspend:) are IDENTICAL to
 *    the agentkit's, so when both runtimes share Upstash, a payment spent
 *    in one can never be spent again in the other.
 *  - BUDDY_OPERATOR=1 bypasses metering (ops testing only — production
 *    widget sessions never set it).
 *
 * Store failures throw (fail closed): the route answers 503 instead of
 * handing out a build it can't account for. Until the Upstash pair lands
 * in Vercel, the store is per-instance in-memory (documented caveat in
 * lib/server/store.ts) — exactly-once then holds per instance.
 */
import { keccak256, toUtf8Bytes } from "ethers";

import { getKvStore, type KvStore } from "@/lib/server/store";

export const BUILD_PRICE_TINYBAR = 500_000_000; // 5 HBAR
const BUDDY_USERNAME = "forge";
const TIPS_CONTRACT_ID = "0.0.10854060";
const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";
const WEI_PER_TINYBAR = 10_000_000_000n;
const MIN_PAYMENT_WEI = BigInt(BUILD_PRICE_TINYBAR) * WEI_PER_TINYBAR; // 5 HBAR in wei

// Atomic claim keys — identical to the ops agentkit metering.
const PAY_CLAIM_PREFIX = "buddy:payclaim:"; // credit: one winner records the payment
const PAY_SPEND_PREFIX = "buddy:payspend:"; // spend: one winner assigns the payment to a build
// Session ledger key — same buddy:chat: scheme as the agentkit, keyed here by
// the wallet's EVM address (what the dapp session token carries).
const LEDGER_PREFIX = "buddy:chat:";
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches the app session

export const BUILD_PAYWALL_ANON =
  "A custom blockpage build is 5 HBAR, and builds need a connected wallet. " +
  "Connect your wallet (top-right), then tip 5 HBAR to my 'forge' page — " +
  "I'll start building the moment it settles on-chain.";

export const BUILD_PAYWALL_UNPAID =
  "A custom blockpage build is 5 HBAR. Tip 5 HBAR to my 'forge' page in " +
  "the app and I'll start building the moment it settles on-chain.";

export const BUILD_RACE_MESSAGE =
  "Your 5 HBAR build payment was just used by another request — nothing " +
  "was charged twice. Please run the build again.";

export const BUILD_FINALIZE_ERROR =
  "I couldn't finalize your build payment just now — nothing was charged. " +
  "Please try again in a bit.";

export const BUILD_STORE_ERROR =
  "I can't check build payments right now — try again in a bit. Nothing was charged.";

/** Operator bypass for Danny's own testing (BUDDY_OPERATOR=1, ops only). */
export function meteringBypass(): boolean {
  return process.env.BUDDY_OPERATOR === "1";
}

type BuildPayment = { id: string; kind: null | "build" };
type BuildLedger = {
  v: 1;
  payments: BuildPayment[];
  /** Payment ids already credited — mirror-node discovery dedupe. */
  consumed: string[];
};

function blankLedger(): BuildLedger {
  return { v: 1, payments: [], consumed: [] };
}

function ledgerKey(evmAddress: string): string {
  return `${LEDGER_PREFIX}${evmAddress.toLowerCase()}`;
}

function normalizeLedger(raw: unknown): BuildLedger {
  const out = blankLedger();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.payments)) {
    for (const p of r.payments as Array<Record<string, unknown>>) {
      if (p && typeof p.id === "string" && (p.kind === null || p.kind === "build")) {
        out.payments.push({ id: p.id, kind: p.kind });
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

async function loadLedger(store: KvStore, evm: string): Promise<BuildLedger> {
  const raw = await store.get(ledgerKey(evm));
  if (!raw) return blankLedger();
  try {
    return normalizeLedger(JSON.parse(raw));
  } catch {
    return blankLedger();
  }
}

async function saveLedger(
  store: KvStore,
  evm: string,
  ledger: BuildLedger
): Promise<void> {
  await store.set(ledgerKey(evm), JSON.stringify(ledger), CLAIM_TTL_MS);
}

function topic0TipSent(): string {
  return keccak256(toUtf8Bytes("TipSent(string,address,address,uint256,uint256)"));
}
function topic1Forge(): string {
  return keccak256(toUtf8Bytes(BUDDY_USERNAME));
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
    const topic2 =
      "0x" + evmAddress.slice(2).toLowerCase().padStart(64, "0");
    const url =
      `${MIRROR_BASE}/contracts/${TIPS_CONTRACT_ID}/results/logs` +
      `?topic0=${topic0TipSent()}&topic1=${topic1Forge()}&topic2=${topic2}` +
      `&order=desc&limit=50`;
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
  const evm = evmAddress.toLowerCase();
  const ledger = await loadLedger(store, evm);
  if (ledger.payments.some((p) => p.kind === null)) return { allowed: true };
  const known = [
    ...ledger.payments.map((p) => p.id),
    ...ledger.consumed,
  ];
  const fresh = await discoverFreshPayments(evm, known);
  let credited = false;
  for (const id of fresh) {
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
      if (!ledger.consumed.includes(id)) ledger.consumed.push(id);
      if (!ledger.payments.some((p) => p.id === id)) {
        ledger.payments.push({ id, kind: null });
      }
      credited = true;
    }
  }
  if (credited) await saveLedger(store, evm, ledger);
  if (ledger.payments.some((p) => p.kind === null)) return { allowed: true };
  return { allowed: false, reason: BUILD_PAYWALL_UNPAID };
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
  const evm = evmAddress.toLowerCase();
  for (let attempt = 0; attempt < 3; attempt++) {
    const ledger = await loadLedger(store, evm);
    const p = ledger.payments.find((x) => x.kind === null);
    if (!p) return false;
    // Atomic spend claim (global per payment id): the first caller to win
    // assigns this payment to its build. A lost race retries against the
    // next unused payment instead of spending twice.
    if (
      await store.setNx(
        `${PAY_SPEND_PREFIX}${encodeURIComponent(p.id)}`,
        evm,
        CLAIM_TTL_MS
      )
    ) {
      p.kind = "build";
      await saveLedger(store, evm, ledger);
      return true;
    }
  }
  return false;
}
