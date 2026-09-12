/**
 * Voicescape Social Town Hall — dust-fee verification.
 *
 * Every forum post, chat message, proposal and listing costs an HBAR dust
 * fee (default 2,000,000 tinybars = 0.02 HBAR) sent to the treasury
 * address. The client supplies the Hedera transaction id of its fee
 * transfer; the server verifies via the free mirror node REST API that
 * the tx succeeded, transferred enough to the treasury, and was paid by
 * the caller's own wallet. Each fee tx id is single-use (see the consumed
 * registry below).
 *
 * The pure `evaluateDustFeeTransfer` is unit-testable; `verifyDustFee`
 * performs the mirror-node fetch (mock it in tests).
 */

import { dustFeeTinybars, mirrorBaseUrl, treasuryAddress } from "./topics";
import { getKvStore } from "../store";

export interface DustFeeResult {
  ok: boolean;
  /** Machine/human-readable reason when !ok. */
  reason: string;
  /** Tinybars actually received by the treasury (null when unknown). */
  receivedTinybars: number | null;
  /** Payer account id parsed from the tx's own transaction_id (0.0.x), when available. */
  payer?: string | null;
}

interface MirrorTransfer {
  account: string;
  amount: number;
  is_approval?: boolean;
}

interface MirrorTransaction {
  result: string;
  name: string;
  /**
   * Full mirror-node transaction id, e.g. "0.0.123@1694000000.000000000".
   * The payer account is the part before "@".
   */
  transaction_id?: string;
  transfers?: MirrorTransfer[];
}

interface MirrorTxResponse {
  transactions?: MirrorTransaction[];
}

interface MirrorAccountResponse {
  account?: string;
}

const ACCOUNT_ID_RE = /^\d+\.\d+\.\d+$/;

/**
 * Payer account id (0.0.x) parsed from the mirror tx's own transaction_id.
 * The transaction_id is authoritative — it names the account that paid for
 * and signed the fee transfer.
 */
export function dustFeePayer(tx: MirrorTransaction | null | undefined): string | null {
  const id = tx?.transaction_id;
  if (!id || typeof id !== "string") return null;
  const payer = id.split("@")[0]?.trim();
  return payer && ACCOUNT_ID_RE.test(payer) ? payer : null;
}

/* ------------------------------------------------------------------ */
/* Consumed fee-transaction registry (replay protection)              */
/* ------------------------------------------------------------------ */

/**
 * One fee payment buys exactly one write: every accepted dust-fee tx id is
 * recorded here and rejected on reuse.
 *
 * Backed by the shared store (lib/server/store.ts): with Upstash
 * configured, reservations and consumed records are atomic across
 * instances (SET … NX PX); without it, the in-memory fallback keeps
 * single-instance correctness. Consumed records live 7 days.
 */
const CONSUMED_FEE_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * In-flight reservations close a check-then-act race: two requests that
 * present the same fee tx id concurrently must not BOTH pass the
 * "not consumed" check and then both verify OK. The reservation is an
 * atomic claim-or-reject (one store round-trip, no await between check
 * and mark) — so the second request sees it even while the first is
 * still awaiting mirror-node verification. Stale reservations (a verify
 * that never returned) expire after IN_FLIGHT_FEE_TTL_MS.
 */
const IN_FLIGHT_FEE_TTL_MS = 5 * 60 * 1000;

function feeKey(txId: string): string {
  return `vs:feefx:${txId}`;
}

/** True when this fee tx id already paid for a write (and hasn't expired). */
export async function isDustFeeTxConsumed(txId: string): Promise<boolean> {
  return (await getKvStore().get(feeKey(txId))) === "consumed";
}

/**
 * Atomically reserve a fee tx id for the write currently being
 * verified. Returns false when the tx id is already consumed OR already
 * reserved by a concurrent in-flight verification — in both cases the
 * caller must reject with "dust fee already used". Callers must
 * releaseDustFeeTx on verification failure (the fee stays retryable) or
 * consumeDustFeeTx on success (the reservation becomes permanent).
 */
export async function reserveDustFeeTx(txId: string): Promise<boolean> {
  return getKvStore().setNx(feeKey(txId), "reserved", IN_FLIGHT_FEE_TTL_MS);
}

/** Release an in-flight reservation after a failed verification. */
export async function releaseDustFeeTx(txId: string): Promise<void> {
  await getKvStore().del(feeKey(txId));
}

/**
 * Record a fee tx id as spent. Call only AFTER the fee verified OK —
 * consuming before verification would burn the user's fee on a transient
 * mirror-node failure and force them to pay again. Converts an existing
 * in-flight reservation into the permanent consumed record.
 */
export async function consumeDustFeeTx(txId: string): Promise<void> {
  await getKvStore().set(feeKey(txId), "consumed", CONSUMED_FEE_TTL_MS);
}

/** Test-only: empty the consumed registry (and in-flight reservations). */
export async function clearConsumedDustFees(): Promise<void> {
  await getKvStore().clearPrefix("vs:feefx:");
}

/* ------------------------------------------------------------------ */
/* User-signed HCS tx replay protection                               */
/* ------------------------------------------------------------------ */

/**
 * In the user-signed architecture the HCS transaction id is the write
 * credential: the server verifies (via mirror node) that the tx exists,
 * succeeded, targeted the right topic, and was paid for by the caller.
 * Without replay protection, a valid txId could be re-presented to
 * perform a second write for free. Each HCS txId is therefore
 * single-use: reserved atomically before verification, released on
 * failure (the tx stays retryable), consumed permanently on success.
 *
 * Same store mechanics as the dust-fee registry above (atomic SET NX,
 * TTL-bounded reservations).
 */
const HCS_TX_RESERVED_TTL_MS = 5 * 60 * 1000;
const HCS_TX_CONSUMED_TTL_MS = 7 * 24 * 3600 * 1000;

function hcsTxKey(txId: string): string {
  return `vs:hcstx:${txId}`;
}

/**
 * Atomically reserve an HCS tx id for the write being verified. Returns
 * false when the tx id is already consumed OR already reserved by a
 * concurrent in-flight verification — the caller must reject. Callers
 * must releaseHcsTxId on verification failure or consumeHcsTxId on
 * success.
 */
export async function reserveHcsTxId(txId: string): Promise<boolean> {
  return getKvStore().setNx(hcsTxKey(txId), "reserved", HCS_TX_RESERVED_TTL_MS);
}

/** Release an in-flight reservation after a failed verification. */
export async function releaseHcsTxId(txId: string): Promise<void> {
  await getKvStore().del(hcsTxKey(txId));
}

/**
 * Record an HCS tx id as spent. Call only AFTER the write verified OK.
 * Converts the in-flight reservation into the permanent consumed record.
 */
export async function consumeHcsTxId(txId: string): Promise<void> {
  await getKvStore().set(hcsTxKey(txId), "consumed", HCS_TX_CONSUMED_TTL_MS);
}

/** Test-only: empty the consumed HCS tx registry (and in-flight reservations). */
export async function clearConsumedHcsTxIds(): Promise<void> {
  await getKvStore().clearPrefix("vs:hcstx:");
}

/**
 * Pure evaluation: does this mirror-node transaction record show a
 * sufficient transfer to the treasury? When `expectedPayerId` is given, the
 * tx's payer must also match it (sender binding). Unit-testable.
 */
export function evaluateDustFeeTransfer(
  tx: MirrorTransaction | null | undefined,
  treasury: string,
  requiredTinybars: number,
  expectedPayerId: string | null = null,
): DustFeeResult {
  if (!tx) {
    return { ok: false, reason: "fee transaction not found", receivedTinybars: null };
  }
  if (tx.result !== "SUCCESS") {
    return { ok: false, reason: `fee transaction did not succeed (result=${tx.result})`, receivedTinybars: null };
  }
  const payer = dustFeePayer(tx);
  if (expectedPayerId) {
    if (!payer) {
      return {
        ok: false,
        reason: "fee transaction has no parseable payer account",
        receivedTinybars: null,
        payer,
      };
    }
    if (payer !== expectedPayerId.trim()) {
      return {
        ok: false,
        reason:
          `dust fee was paid by ${payer}, not by your wallet (${expectedPayerId}) — ` +
          "pay the fee from the wallet you signed in with",
        receivedTinybars: null,
        payer,
      };
    }
  }
  const treasuryNorm = treasury.trim();
  let received = 0;
  for (const t of tx.transfers ?? []) {
    if (t.account === treasuryNorm && t.amount > 0) received += t.amount;
  }
  if (received >= requiredTinybars) {
    return { ok: true, reason: "ok", receivedTinybars: received, payer };
  }
  return {
    ok: false,
    reason: `insufficient dust fee: treasury received ${received} tinybars, need ${requiredTinybars}`,
    receivedTinybars: received,
    payer,
  };
}

export interface MirrorPort {
  /**
   * Verify the caller-supplied fee tx id. When `expectedSender` is given,
   * the fee must have been paid by that wallet: a 0.0.x id is compared
   * directly, a 0x… EVM address is first resolved to its Hedera account id
   * via the mirror node /api/v1/accounts/<evm-address>.
   */
  verifyDustFee(dustFeeTxId: string, expectedSender?: string): Promise<DustFeeResult>;
  /** The fee the server expects (tinybars) + where it goes. */
  feeInfo(): { dustFeeTinybars: number; treasury: string | null };
  /**
   * Resolve a wallet address to a Hedera account id.
   * 0.0.x passes through; 0x… is resolved via the mirror node.
   * Null when malformed or unresolvable.
   */
  resolveAccountId(address: string): Promise<string | null>;
}

export class RealMirrorPort implements MirrorPort {
  feeInfo() {
    return { dustFeeTinybars: dustFeeTinybars(), treasury: treasuryAddress() };
  }

  /**
   * Resolve a session wallet address to a Hedera account id for payer
   * comparison. 0.0.x passes through; 0x… is resolved via the mirror node.
   * Null when the address is malformed or unresolvable.
   */
  async resolveAccountId(address: string): Promise<string | null> {
    const a = address.trim();
    if (ACCOUNT_ID_RE.test(a)) return a;
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
    let res: Response;
    try {
      res = await fetch(`${mirrorBaseUrl()}/api/v1/accounts/${a.toLowerCase()}`);
    } catch {
      return null;
    }
    if (!res.ok) return null;
    let data: MirrorAccountResponse;
    try {
      data = (await res.json()) as MirrorAccountResponse;
    } catch {
      return null;
    }
    return data.account && ACCOUNT_ID_RE.test(data.account) ? data.account : null;
  }

  async verifyDustFee(dustFeeTxId: string, expectedSender?: string): Promise<DustFeeResult> {
    const treasury = treasuryAddress();
    if (!treasury) {
      return { ok: false, reason: "NEXT_PUBLIC_TREASURY_ADDRESS is not configured", receivedTinybars: null };
    }
    if (!dustFeeTxId || !dustFeeTxId.includes("@")) {
      return { ok: false, reason: "dustFeeTxId must be a Hedera transaction id like 0.0.1234@1694...", receivedTinybars: null };
    }
    let expectedPayerId: string | null = null;
    if (expectedSender) {
      expectedPayerId = await this.resolveAccountId(expectedSender);
      if (!expectedPayerId) {
        return {
          ok: false,
          reason: "could not resolve your wallet to a Hedera account — sign in again and retry",
          receivedTinybars: null,
        };
      }
    }
    const url = `${mirrorBaseUrl()}/api/v1/transactions/${encodeURIComponent(dustFeeTxId)}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      return { ok: false, reason: `mirror node unreachable: ${e instanceof Error ? e.message : String(e)}`, receivedTinybars: null };
    }
    if (res.status === 404) {
      return { ok: false, reason: "fee transaction not found on the mirror node", receivedTinybars: null };
    }
    if (!res.ok) {
      return { ok: false, reason: `mirror node error (${res.status})`, receivedTinybars: null };
    }
    const data = (await res.json()) as MirrorTxResponse;
    const tx = (data.transactions ?? [])[0];
    return evaluateDustFeeTransfer(tx, treasury, dustFeeTinybars(), expectedPayerId);
  }
}

let singleton: MirrorPort | null = null;

export function defaultMirrorPort(): MirrorPort {
  if (!singleton) singleton = new RealMirrorPort();
  return singleton;
}
