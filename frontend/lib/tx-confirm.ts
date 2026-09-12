/**
 * Reactive post-transaction confirmation.
 *
 * After a wallet returns an approved/signed transaction, the UI must not sit
 * frozen on "Tipping…" / "Posting…" — the wallet response only proves the
 * user approved, not that the transaction reached consensus. This module
 * polls the Hedera mirror node until the transaction resolves, with backoff
 * and a hard cap, so every write flow can show a live "Confirming on
 * Hedera…" state followed by a definitive confirmed / failed / timeout
 * outcome. Nobody is ever left on an endless spinner.
 *
 * (The older lib/verify-tx.ts helpers do a stricter contract-event check;
 * they remain for flows that need event-level proof. This module is the
 * generic, fast transaction-status check used for reactive UI.)
 *
 * Why the mirror node and not the SDK's receipt query: after a wallet
 * (HashPack via hedera-wallet-connect DAppConnector, HIP-820) signs AND
 * executes a transaction, the app never holds a TransactionResponse — only
 * the tx id string. The SDK's getReceipt()/TransactionReceiptQuery path
 * needs a node connection + operator and is the wrong tool for post-hoc
 * status; the mirror-node REST `GET /api/v1/transactions/{id}` is the
 * official Hedera-documented pattern for exactly this ("check a
 * transaction's result by id"), and it is what the repo's existing
 * wallet-recovery paths (checkTxLanded, checkHcsTxLanded) already use.
 * Verified 2026-09-12: a direct SDK TransactionReceiptQuery hung with no
 * response in this environment while the mirror REST answered in ~1s.
 */

export type TxPollOutcome = "confirmed" | "failed" | "timeout";

export interface TxPollOptions {
  /**
   * Hard cap on total polling time. Defaults to 50s (inside the 45–60s
   * budget — long enough to ride out mirror-node lag, short enough that
   * the user gets an honest answer).
   */
  timeoutMs?: number;
  /** Base delay between attempts; grows linearly with backoff. Default 2s. */
  baseDelayMs?: number;
  /** Maximum delay between attempts. Default 8s. */
  maxDelayMs?: number;
  /** Mirror node REST base. Defaults to Hedera mainnet. */
  mirrorBase?: string;
  /** Abort polling early (e.g. component unmount). */
  signal?: AbortSignal;
}

const DEFAULT_MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";

interface MirrorTransaction {
  result?: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll the mirror node until a transaction reaches a terminal state.
 *
 * @param txId SDK-format transaction id ("0.0.x-…") or EVM hash ("0x…").
 * @returns "confirmed" when the mirror node reports result SUCCESS,
 *          "failed" when it reports any other terminal result (e.g. a
 *          contract revert), "timeout" when nothing resolved before the cap.
 *          Rejects only when aborted via `signal`.
 */
export async function pollTransactionStatus(
  txId: string,
  opts: TxPollOptions = {},
): Promise<TxPollOutcome> {
  const {
    timeoutMs = 50_000,
    baseDelayMs = 2000,
    maxDelayMs = 8000,
    mirrorBase = DEFAULT_MIRROR_BASE,
    signal,
  } = opts;
  const deadline = Date.now() + timeoutMs;
  const url = `${mirrorBase}/transactions/${encodeURIComponent(txId)}`;
  let attempt = 0;

  for (;;) {
    if (signal?.aborted) throw new Error("aborted");
    let result: string | undefined;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { transactions?: MirrorTransaction[] };
        result = data.transactions?.[0]?.result;
      }
      // Not ok (404 while the tx propagates) or no result yet — keep polling.
    } catch {
      // Network blip — keep polling.
    }
    if (result === "SUCCESS") return "confirmed";
    // A terminal result that isn't SUCCESS (e.g. CONTRACT_REVERT_EXECUTED)
    // means the transaction definitively failed on-chain — stop polling.
    if (result) return "failed";

    attempt += 1;
    const delay = Math.min(maxDelayMs, baseDelayMs + (attempt - 1) * 1000);
    const waitMs = Math.min(delay, deadline - Date.now());
    if (waitMs <= 0) return "timeout";
    await sleep(waitMs, signal);
  }
}

/**
 * "12.4 seconds" — elapsed time from wallet approval to consensus finality,
 * shown on the success receipt as exact finality proof.
 */
export function formatFinalitySecs(elapsedMs: number): string {
  const secs = Math.max(0, elapsedMs / 1000);
  return `${secs.toFixed(1)} seconds`;
}

/**
 * "7:40:50 PM" — the exact local time the transaction reached consensus.
 */
export function formatFinalizedAt(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}
