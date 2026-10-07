/**
 * Reactive post-transaction confirmation.
 *
 * After a wallet returns an approved/signed transaction, the UI must not sit
 * frozen on "Tipping…" / "Posting…" — the wallet response only proves the
 * user approved, not that the transaction reached consensus. This module
 * polls the Hedera mirror node until the transaction resolves, with backoff
 * and a hard cap, so every write flow can show a live "Confirming on
 * Hedera…" state followed by a definitive confirmed / failed / expired /
 * timeout outcome. Nobody is ever left on an endless spinner.
 *
 * On the "unknown" state: a missing transaction is NEVER treated as proof
 * of anything on its own. The poll consults the mirror node's own index
 * frontier (the newest block's consensus timestamp) and only interprets
 * "still not found" as "expired" once the mirror has indexed past the
 * transaction's validity window (valid start + margin). Before that signal,
 * a missing transaction stays "unknown" — still pending, never permission
 * to re-submit a duplicate semantic action.
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

export type TxPollOutcome = "confirmed" | "failed" | "timeout" | "expired";

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
  /**
   * Mirror catch-up margin (ms) used before a still-missing transaction may
   * be called "expired". Defaults to 5 minutes: Hedera transaction validity
   * is 120s, so once the mirror's index frontier has passed
   * validStart + margin, a transaction that still isn't there can never
   * land. Set to 0 to disable the catch-up check (missing transactions then
   * only ever resolve as "timeout").
   */
  catchUpMarginMs?: number;
  /**
   * Called with the mirror node's `consensus_timestamp` (seconds.nanos)
   * when the transaction confirms — the network-assigned settlement time,
   * not the device clock. Receipts should display this as the finality
   * time; it is the provably-fair timestamp for the transaction.
   */
  onConsensus?: (consensusTimestamp: string | null) => void;
}

const DEFAULT_MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";

/**
 * Normalize a transaction id to the mirror node's format.
 *
 * Wallets and the SDK produce `0.0.x@seconds.nanos`, but the mirror node's
 * `/transactions/{id}` endpoint only answers the dash form
 * (`0.0.x-seconds-nanos`). Passing the @ form through silently finds
 * nothing — every caller polling a wallet-produced txId would spin until
 * timeout. EVM hashes (`0x…`) pass through untouched.
 */
export function toMirrorTxId(txId: string): string {
  const at = txId.indexOf("@");
  if (at === -1) return txId;
  const payer = txId.slice(0, at);
  const rest = txId.slice(at + 1).replace(".", "-");
  return `${payer}-${rest}`;
}

interface MirrorTransaction {
  result?: string;
  /** Network-assigned settlement time, "seconds.nanos" (e.g. "1789520539.844492534"). */
  consensus_timestamp?: string;
}

/**
 * Parse a Hedera mirror-node consensus timestamp ("seconds.nanos") into a
 * Date. String-split on the decimal point — never parseFloat the whole
 * value, which loses nanosecond precision and can shift the second.
 */
export function consensusTimestampToDate(ts: string): Date | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(ts.trim());
  if (!m) return null;
  const secs = Number(m[1]);
  const nanos = m[2] ? Number(`0.${m[2]}`) : 0;
  const ms = secs * 1000 + Math.floor(nanos * 1000);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Mirror catch-up margin: how far past a transaction's valid start the
 * mirror node's index frontier must be before "still not found" is treated
 * as "expired" (never landed). Hedera transactions are valid for 120s after
 * their valid start; the remaining 180s covers mirror indexing lag.
 */
export const MIRROR_CATCHUP_MARGIN_MS = 300_000;

/**
 * Parse a Hedera transaction id's valid start ("0.0.x@seconds.nanos") into
 * milliseconds since the epoch. Returns null when the id carries no
 * parseable valid start (EVM hashes, malformed ids) — callers treat null as
 * "no catch-up signal available" and must NOT declare finality.
 */
export function parseTxValidStartMs(txId: string): number | null {
  const at = txId.indexOf("@");
  if (at === -1) return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(txId.slice(at + 1).trim());
  if (!m) return null;
  const secs = Number(m[1]);
  const nanos = m[2] ? Number(`0.${m[2]}`) : 0;
  const ms = secs * 1000 + Math.floor(nanos * 1000);
  return Number.isFinite(ms) ? ms : null;
}

interface MirrorBlock {
  timestamp?: { from?: string; to?: string };
}

/**
 * Read the mirror node's index frontier: the consensus timestamp of the
 * newest block it has indexed. This is THE signal for whether the mirror
 * has "caught up" — a transaction whose validity window closed before this
 * frontier and still isn't indexed can never land.
 *
 * Returns null on any failure (fail-safe: no signal means no finality
 * verdict, never a default of "caught up").
 */
export async function getMirrorHeadTimestampMs(
  mirrorBase: string = DEFAULT_MIRROR_BASE,
): Promise<number | null> {
  try {
    const res = await fetchWithAttemptTimeout(`${mirrorBase}/blocks?limit=1&order=desc`);
    if (!res.ok) return null;
    const data = (await res.json()) as { blocks?: MirrorBlock[] };
    const to = data.blocks?.[0]?.timestamp?.to;
    if (!to) return null;
    return consensusTimestampToDate(to)?.getTime() ?? null;
  } catch {
    return null;
  }
}

/**
 * Has the mirror node's index frontier moved past this transaction's
 * validity window (valid start + margin)? Only then is "still not found"
 * meaningful. Returns false whenever the signal is unavailable — unknown
 * stays unknown.
 */
export function isMirrorBeyondTxWindow(
  txId: string,
  headTimestampMs: number | null,
  marginMs: number = MIRROR_CATCHUP_MARGIN_MS,
): boolean {
  if (headTimestampMs == null) return false;
  const validStartMs = parseTxValidStartMs(txId);
  if (validStartMs == null) return false;
  return headTimestampMs >= validStartMs + marginMs;
}

/**
 * Per-attempt fetch timeout for mirror-node polling. The poll loop has an
 * overall cap, but each individual fetch was unbounded — a stalled TCP
 * connection could push the poll past its cap. ~15s per attempt degrades to
 * "no answer this round" instead of hanging the whole poll.
 */
const ATTEMPT_TIMEOUT_MS = 15_000;
async function fetchWithAttemptTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    return await fetch(url, { cache: "no-store", signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
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
 *          contract revert), "expired" when the mirror node's index frontier
 *          has moved past the transaction's validity window (valid start +
 *          catchUpMarginMs) and the transaction still isn't there — it can
 *          never land, and nothing was submitted, so retrying with a fresh
 *          transaction id is safe. "timeout" when nothing resolved before
 *          the cap and the mirror may still be behind — the outcome is
 *          genuinely unknown, and a retry must reuse the SAME transaction id
 *          (the network dedupes it) or wait.
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
    catchUpMarginMs = MIRROR_CATCHUP_MARGIN_MS,
  } = opts;
  const deadline = Date.now() + timeoutMs;
  const url = `${mirrorBase}/transactions/${encodeURIComponent(toMirrorTxId(txId))}`;
  let attempt = 0;

  for (;;) {
    if (signal?.aborted) throw new Error("aborted");
    let result: string | undefined;
    let consensusTs: string | null = null;
    try {
      const res = await fetchWithAttemptTimeout(url);
      if (res.ok) {
        const data = (await res.json()) as { transactions?: MirrorTransaction[] };
        result = data.transactions?.[0]?.result;
        consensusTs = data.transactions?.[0]?.consensus_timestamp ?? null;
      }
      // Not ok (404 while the tx propagates) or no result yet — keep polling.
    } catch {
      // Network blip — keep polling.
    }
    if (result === "SUCCESS") {
      // Surface the network-assigned settlement time so receipts can show
      // the true consensus timestamp instead of the device clock.
      try {
        opts.onConsensus?.(consensusTs);
      } catch {
        // A throwing callback must not fail confirmation.
      }
      return "confirmed";
    }
    // A terminal result that isn't SUCCESS (e.g. CONTRACT_REVERT_EXECUTED)
    // means the transaction definitively failed on-chain — stop polling.
    if (result) return "failed";

    // Still missing: consult the mirror's index frontier before deciding
    // this is just lag. Checked every 4th attempt (the frontier moves
    // slowly; no need to hammer the blocks endpoint). A null head means no
    // signal — keep polling, never declare finality without it.
    attempt += 1;
    if (catchUpMarginMs > 0 && attempt % 4 === 0) {
      const headMs = await getMirrorHeadTimestampMs(mirrorBase);
      if (isMirrorBeyondTxWindow(txId, headMs, catchUpMarginMs)) return "expired";
    }

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
