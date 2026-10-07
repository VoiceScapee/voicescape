/**
 * prepared-tx — submit a pre-built (unsigned) Hedera transaction from the
 * user's own wallet pairing. Shared by the in-chat one-tap action card and
 * the /agents/claim fallback page, so both run the exact same submission
 * path.
 *
 * Hedera-native only: the existing DAppConnector pairing (HIP-820), the
 * official @hiero-ledger/sdk bytes, official mirror-node REST for
 * confirmation. No keys are ever stored or handled here — the wallet signs;
 * this module only drives the request. No new chain libraries.
 *
 * UX contract (Brandon's one-tap directive): the human's ONLY action is the
 * Approve tap. This module silently restores the pairing and probes
 * liveness first (isWalletSessionAlive is a read-only balance check — it
 * never prompts). When the probe fails it re-wakes the session once
 * (rebuilds the relay transport from the persisted pairing — the usual
 * victim is a socket that died while the tab was backgrounded during an
 * app-switch pairing) and re-probes. It surfaces an error only when the
 * agent cannot fix the state itself: no pairing at all (the user must
 * connect — inherently a human action), or a dead pairing (needs a
 * re-pair the agent can't do).
 *
 * HONEST CONSTRAINT (code comment, not user-facing copy): the wallet app
 * itself may show its own signature prompt when the request fires — that
 * is the wallet's security UI, not ours. Our UX is one tap; the agent does
 * the rest. Do not add extra in-app confirmation screens around this.
 */
import {
  getHederaPairing,
  restoreHederaPairing,
  rewakeHederaPairing,
  isWalletSessionAlive,
  isPairingFresh,
  REWAKE_PROBE_TIMEOUT_MS,
  STALE_CONNECTION_COPY,
} from "./wallet";
import { reportError } from "./report-error";

/** A frozen, unsigned transaction handed to us by the agent's preparation step. */
export interface PreparedTxPayload {
  /** Frozen unsigned tx bytes, base64 (built at tap time by the finalize endpoint). */
  transactionList: string;
  /** Signer in CAIP form, e.g. "hedera:mainnet:0.0.12345". */
  signerAccountId: string;
  /** The frozen tx's own id, "0.0.x@seconds.nanos" — used for mirror-node confirmation. */
  transactionId: string;
}

export type PreparedTxPhase = "checking" | "signing" | "confirming";

/** Thrown when there is no wallet pairing and the silent restore found none. */
export class NoWalletPairingError extends Error {}
/** Thrown when the pairing exists but the wallet no longer answers (stale). */
export class StaleWalletPairingError extends Error {}
/** Thrown when the connected wallet isn't the account the action names. */
export class OwnerMismatchError extends Error {}

const SIGN_TIMEOUT_MS = 30_000; // wallet signature prompt budget
const CONFIRM_POLL_MS = 4_000; // mirror-node poll cadence
const CONFIRM_DEADLINE_MS = 120_000; // 2 minutes, then hand the user the HashScan link
/**
 * Pairings approved within this window skip the wallet-round-trip liveness
 * probe — the approval itself arrived over the relay seconds ago, so the
 * pairing is definitionally alive. (2026-10-07: the probe's
 * hedera_signAndExecuteQuery went unanswered by a freshly-paired HashPack
 * on iOS, producing a false "stale" verdict that blocked the signature.)
 */
const FRESH_PAIRING_SKIP_PROBE_MS = 120_000;
const MIRROR_BASE = "https://mainnet.mirrornode.hedera.com/api/v1";

/** "0.0.123@1700000000.000000000" -> "0.0.123-1700000000-000000000" (mirror/HASHScan form). */
export function toMirrorTxId(txId: string): string {
  const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(txId.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : txId;
}

export function hashscanTxUrl(txId: string): string {
  return `https://hashscan.io/mainnet/transaction/${toMirrorTxId(txId)}`;
}

/** Compare account ids across forms ("0.0.123" vs 0x…7b EVM address). */
export function normalizeAccountId(a: string): string {
  const t = a.trim();
  const m = /^0\.0\.(\d+)$/.exec(t);
  if (m) return `0x${BigInt(m[1]).toString(16).padStart(40, "0")}`;
  return t.toLowerCase();
}

async function txLanded(txId: string): Promise<"success" | "failed" | "unknown"> {
  try {
    const res = await fetch(
      `${MIRROR_BASE}/transactions/${encodeURIComponent(toMirrorTxId(txId))}`,
      { cache: "no-store" },
    );
    if (res.status === 404) return "unknown"; // not visible yet
    if (!res.ok) return "unknown"; // transient mirror trouble — keep polling
    const body = (await res.json()) as { transactions?: Array<{ result?: string }> };
    const result = body.transactions?.[0]?.result;
    if (result === "SUCCESS") return "success";
    if (typeof result === "string" && result !== "SUCCESS") return "failed";
    return "unknown";
  } catch {
    return "unknown"; // network blip — keep polling until the deadline
  }
}

export interface SubmitPreparedTxResult {
  txId: string;
  /** False only when the 2-minute mirror window expired without a receipt. */
  confirmed: boolean;
}

/**
 * The whole post-tap pipeline: silently ensure a live pairing, fire the
 * signature request through the existing DAppConnector pairing, then poll
 * the mirror node until the receipt lands. The caller (one-tap card or
 * claim page) maps the thrown errors to its own honest copy.
 *
 * Never silently fails: every unfixable state throws, and every failure
 * (except the user's own dismissal at the wallet) is reported.
 */
export async function submitPreparedTx(
  payload: PreparedTxPayload,
  opts: {
    /** Attempt a silent pairing restore when none is live. Default true; the /agents/claim fallback page passes false (its own connect UI owns pairing). */
    restoreIfMissing?: boolean;
    /** "0.0.x" — refuse when the paired wallet isn't the account the action names. */
    expectedOwnerAccountId?: string;
    onPhase?: (phase: PreparedTxPhase) => void;
  } = {},
): Promise<SubmitPreparedTxResult> {
  const phase = opts.onPhase ?? (() => {});
  phase("checking");

  // 1. Ensure a pairing, silently if allowed.
  let pairing = getHederaPairing();
  if (!pairing && opts.restoreIfMissing !== false) {
    const restored = await restoreHederaPairing();
    pairing = restored ? getHederaPairing() : null;
  }
  if (!pairing) {
    reportError(new Error("no wallet pairing for prepared tx"), "prepared-tx", {
      action: "approve-action",
      walletState: "disconnected",
    });
    throw new NoWalletPairingError(
      "No wallet connected — connect your wallet, then tap Approve again.",
    );
  }

  // 2. Silent liveness probe. Read-only, never prompts, never throws.
  //    A dead pairing can't be fixed by the agent — surface it.
  //
  //    SKIPPED for fresh pairings: the probe is a wallet-round-trip query
  //    (hedera_signAndExecuteQuery) and some wallets don't answer it even
  //    when the session is healthy — most visibly HashPack on iOS right
  //    after a deep-link pairing. A pairing approved <2min ago is
  //    definitionally alive (the approval arrived over the relay seconds
  //    ago), so probing only risks a false "stale" verdict that blocks the
  //    signature. The sign request below is the real liveness test: its own
  //    30s timeout plus the verify-on-chain fallback handle a truly dead
  //    wallet without misdiagnosing a live one.
  if (!isPairingFresh(FRESH_PAIRING_SKIP_PROBE_MS)) {
    let alive = await isWalletSessionAlive();
    if (!alive) {
      // The relay socket often dies while the tab is backgrounded during an
      // app-switch pairing: the session is persisted and healthy, only the
      // transport is asleep. Re-wake once (rebuild from the persisted
      // session, exactly like a page reload) and re-probe before calling it
      // stale — the 2026-10-01 claim failure probed dead seconds after a
      // good pairing, and this turns that case into a silent recovery.
      // Never throws; a null re-wake falls through to the stale path below.
      phase("checking");
      const rewoken = await rewakeHederaPairing();
      if (rewoken) {
        pairing = rewoken;
        alive = await isWalletSessionAlive(REWAKE_PROBE_TIMEOUT_MS);
      }
    }
    if (!alive) {
      reportError(new Error("stale wallet pairing for prepared tx"), "prepared-tx", {
        action: "approve-action",
        walletState: "connected",
      });
      throw new StaleWalletPairingError(STALE_CONNECTION_COPY);
    }
  }

  // 3. Refuse to sign as the wrong account — the action names its owner.
  if (opts.expectedOwnerAccountId) {
    const want = normalizeAccountId(opts.expectedOwnerAccountId);
    const have = normalizeAccountId(pairing.accountId);
    if (want && have && want !== have) {
      throw new OwnerMismatchError(
        `This action is for ${opts.expectedOwnerAccountId}, but your connected wallet is ${pairing.accountId}. Connect the right wallet and try again.`,
      );
    }
  }

  // 4. Fire the signature request through the existing DAppConnector
  //    pairing (HIP-820). The wallet app may show ITS OWN signature
  //    prompt here — that is the wallet's security UI, not ours; we add
  //    no in-app confirmation around it.
  phase("signing");
  let timedOut = false;
  try {
    const signAndExecute = pairing.hc.signAndExecuteTransaction as unknown as (
      params: { signerAccountId: string; transactionList: string },
    ) => Promise<unknown>;
    await Promise.race([
      signAndExecute({
        signerAccountId: payload.signerAccountId,
        transactionList: payload.transactionList,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          timedOut = true;
          reject(new Error("WALLET_TIMEOUT"));
        }, SIGN_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    if (timedOut && e instanceof Error && e.message === "WALLET_TIMEOUT") {
      // The wallet went silent after the tap — but the tx may still have
      // been submitted. Never claim failure here; verify on-chain below.
      reportError(new Error("wallet sign timed out; verifying on-chain"), "prepared-tx", {
        action: "approve-action",
        walletState: "connected",
      });
    } else {
      // User dismissed at the wallet, or the wallet refused — report and
      // hand the reason to the caller for honest copy.
      reportError(e, "prepared-tx", { action: "approve-action", walletState: "connected" });
      throw e;
    }
  }

  // 5. Wait for the mirror-node receipt. The human does nothing after the tap.
  phase("confirming");
  const deadline = Date.now() + CONFIRM_DEADLINE_MS;
  for (;;) {
    const landed = await txLanded(payload.transactionId);
    if (landed === "success") return { txId: payload.transactionId, confirmed: true };
    if (landed === "failed") {
      const err = new Error(
        "The transaction failed on-chain — nothing was registered. It's safe to try again.",
      );
      reportError(err, "prepared-tx", { action: "approve-action", walletState: "connected" });
      throw err;
    }
    if (Date.now() >= deadline) return { txId: payload.transactionId, confirmed: false };
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
  }
}
