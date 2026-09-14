/**
 * Liaison revenue sweep (server-only — imports @hiero-ledger/sdk).
 *
 * Tips to the danny page split 98/2 atomically in the Tips contract: 98%
 * lands in the liaison wallet, 2% goes to treasury. This module sweeps the
 * liaison's own received share onward to the Voicescape treasury
 * (0.0.10424063), keeping a small reserve (default 1 HBAR) for the
 * liaison's own transfer fees.
 *
 * PRIME DIRECTIVE PRESERVED: the liaison signs ONLY for its own wallet,
 * moving ONLY its own funds. No user keys, no user funds, no custody —
 * the sweep key (LIAISON_FORWARDER_KEY) is the liaison's own operator key
 * and can only spend from LIAISON_ACCOUNT_ID. User wallets are never
 * touched.
 *
 * Trigger: after each verified tip, when the forwardable balance
 * (balance − reserve) exceeds LIAISON_FORWARD_THRESHOLD_HBAR (default 0,
 * i.e. forward everything above the reserve). Best-effort: a missing key,
 * a low balance, or a failed transfer never fails the tip verification —
 * the funds simply stay in the liaison wallet until the next sweep.
 *
 * SETUP (Brandon, one-time): set LIAISON_FORWARDER_KEY in the Vercel
 * project env to the liaison wallet's ECDSA private key (the same key
 * whose account is 0.0.10857765). Without it, sweeps are skipped and tips
 * accumulate in the liaison wallet — verification still works.
 */
import {
  AccountId,
  Client,
  Hbar,
  Long,
  PrivateKey,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import {
  LIAISON_ACCOUNT_ID,
  LIAISON_TREASURY_ID,
  computeForwardable,
  liaisonForwardReserveHbar,
  liaisonForwardThresholdHbar,
} from "../../liaison";

export interface ForwarderMirrorGet {
  (path: string): Promise<{ ok: boolean; json: unknown }>;
}

export interface ForwardDeps {
  mirrorGet: ForwarderMirrorGet;
  /** Signs + submits the liaison→treasury transfer; resolves the tx id. */
  executeTransfer: (amountTinybar: bigint) => Promise<string>;
  env?: Record<string, string | undefined>;
}

export interface ForwardResult {
  /** True when a sweep transfer was submitted. */
  forwarded: boolean;
  /** Transaction id of the sweep (when forwarded). */
  txId?: string;
  /** Why no sweep happened (when not forwarded). */
  reason?: string;
  /** Balance seen at sweep time, in tinybar (for receipts/debugging). */
  balanceTinybar?: string;
}

/**
 * Run one sweep: read the liaison wallet's balance from the mirror node,
 * and forward everything above the reserve to treasury when it exceeds
 * the threshold. Never throws — callers treat a miss as "try next time".
 */
export async function forwardLiaisonRevenue(deps: ForwardDeps): Promise<ForwardResult> {
  const env = deps.env ?? process.env;
  if (!env.LIAISON_FORWARDER_KEY) {
    return { forwarded: false, reason: "LIAISON_FORWARDER_KEY not configured" };
  }
  const reserveTinybar = BigInt(
    Math.round(liaisonForwardReserveHbar(env) * 100_000_000),
  );
  const thresholdTinybar = BigInt(
    Math.round(liaisonForwardThresholdHbar(env) * 100_000_000),
  );

  let balanceTinybar: bigint;
  try {
    const res = await deps.mirrorGet(`/api/v1/accounts/${LIAISON_ACCOUNT_ID}`);
    if (!res.ok) return { forwarded: false, reason: "mirror node balance read failed" };
    const bal =
      res.json && typeof res.json === "object"
        ? (res.json as { balance?: { balance?: unknown } }).balance?.balance
        : undefined;
    balanceTinybar = typeof bal === "number" || typeof bal === "string" ? BigInt(bal) : 0n;
  } catch {
    return { forwarded: false, reason: "mirror node balance read failed" };
  }

  const amount = computeForwardable(balanceTinybar, reserveTinybar, thresholdTinybar);
  if (amount <= 0n) {
    return {
      forwarded: false,
      reason: "balance below reserve + threshold",
      balanceTinybar: balanceTinybar.toString(),
    };
  }

  try {
    const txId = await deps.executeTransfer(amount);
    return {
      forwarded: true,
      txId,
      balanceTinybar: balanceTinybar.toString(),
    };
  } catch (e) {
    return {
      forwarded: false,
      reason: e instanceof Error ? e.message : "sweep transfer failed",
      balanceTinybar: balanceTinybar.toString(),
    };
  }
}

/**
 * Real mirror-node GET for production wiring.
 */
export async function fetchMirrorJson(path: string): Promise<{ ok: boolean; json: unknown }> {
  const res = await fetch(`https://mainnet.mirrornode.hedera.com${path}`, {
    headers: { Accept: "application/json" },
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON — leave null */
  }
  return { ok: res.ok, json };
}

/**
 * Real sweep transfer: liaison wallet → treasury, signed by the liaison's
 * own key. Reads LIAISON_FORWARDER_KEY from env. Resolves with the
 * transaction id once submitted — intentionally does NOT await the receipt
 * (getReceipt can hang from some networks even when the tx lands; the tx
 * id is verifiable on the mirror node).
 */
export async function sdkExecuteTransfer(amountTinybar: bigint): Promise<string> {
  const keyRaw = process.env.LIAISON_FORWARDER_KEY;
  if (!keyRaw) throw new Error("LIAISON_FORWARDER_KEY not configured");
  const client = Client.forMainnet();
  try {
    const key = PrivateKey.fromString(keyRaw);
    const from = AccountId.fromString(LIAISON_ACCOUNT_ID);
    const to = AccountId.fromString(LIAISON_TREASURY_ID);
    // The liaison signs ONLY for its own wallet, moving ONLY its own funds
    // (its 98% share of verified tips). Negative from / positive to.
    const amount = Hbar.fromTinybars(Long.fromString(amountTinybar.toString()));
    const tx = new TransferTransaction()
      .addHbarTransfer(from, amount.negated())
      .addHbarTransfer(to, amount)
      .setTransactionMemo("voicescape liaison revenue sweep")
      .freezeWith(client);
    const signed = await tx.sign(key);
    const submitted = await signed.execute(client);
    return submitted.transactionId.toString();
  } finally {
    client.close();
  }
}
