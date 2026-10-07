"use client";

import {
  toMirrorTxId,
  getMirrorHeadTimestampMs,
  isMirrorBeyondTxWindow,
  MIRROR_CATCHUP_MARGIN_MS,
} from "./tx-confirm";
import { STALE_CONNECTION_COPY } from "./wallet";
import { fetchWithTimeout } from "./fetch-timeout";
import { isWalletRejection, isWalletSessionAlive } from "./wallet-guards";
import {
  type LandedStatus,
  isHcsIntentKind,
  listPendingIntents,
  reconcilePendingIntents,
  removePendingIntent,
  savePendingIntent,
  UnresolvedIntentError,
} from "./pending-intents";

/**
 * Client-side HCS message submit via the user's wallet.
 *
 * The user signs a TopicMessageSubmitTransaction in their wallet (HashPack,
 * Blade, etc. via HIP-820). This makes Town Hall writes transparent: the
 * user pays the HCS fee from their own account and the transaction is
 * visible on HashScan under their account.
 *
 * The @hiero-ledger/sdk is dynamically imported to avoid bloating the
 * initial bundle (see lib/tx.ts for the same pattern).
 */

export interface HcsSubmitResult {
  /** Hedera transaction ID (e.g. "0.0.1234@1234567890.123456789"). */
  transactionId: string;
}

/**
 * Max HCS message size we will submit. A single HCS chunk carries 1024
 * bytes; the SDK auto-chunks larger messages into multiple transactions,
 * which our server never reassembles. Cap at 900 bytes client-side —
 * BEFORE the user signs and pays — so oversized messages fail fast with a
 * clear error instead of burning real fees on a message that can never be
 * accepted.
 */
export const MAX_HCS_MESSAGE_BYTES = 900;

/**
 * Serialize an HCS message and enforce the single-chunk size budget.
 * Throws with a user-friendly message when the payload is too large —
 * call BEFORE the user signs so they never pay fees for a message that
 * can't be accepted.
 */
export function assertHcsMessageFits(message: object): string {
  const messageJson = JSON.stringify(message);
  const messageBytes = new TextEncoder().encode(messageJson).length;
  if (messageBytes > MAX_HCS_MESSAGE_BYTES) {
    throw new Error(
      `Message is too long (${messageBytes} bytes). HCS messages are capped at ${MAX_HCS_MESSAGE_BYTES} bytes — please shorten your message and try again.`,
    );
  }
  return messageJson;
}

interface WalletSigner {
  signAndExecuteTransaction(params: object): Promise<unknown>;
  accountId: string;
  network: "mainnet"; // mainnet only — no testnet
  /**
   * Optional live DAppConnector for the stale-session pre-check (shared
   * with lib/tx.ts). When provided and the session is dead, the submit
   * fails fast instead of hanging until the wallet timeout.
   */
  walletConnector?: unknown;
}

/**
 * Time-bounded wrapper around checkHcsTxLanded. The wallet-timeout recovery
 * path must not hang a second time on a stalled mirror node — a timeout
 * degrades to "unknown", which keeps the existing stale-session guidance.
 */
const HCS_CHECK_TIMEOUT_MS = 10_000;
function checkHcsTxLandedBounded(
  txId: string,
  network: "mainnet",
): Promise<"success" | "failed" | "unknown"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("unknown"), HCS_CHECK_TIMEOUT_MS);
    checkHcsTxLanded(txId, network).then(
      (s) => {
        clearTimeout(timer);
        resolve(s);
      },
      () => {
        clearTimeout(timer);
        resolve("unknown");
      },
    );
  });
}

/**
 * Full landed status for an HCS tx id, including expiry: once the mirror's
 * index frontier has moved past the tx's validity window without seeing it,
 * the tx can never land. Used by the HCS pending-intent gate.
 */
async function checkHcsLandedStatus(txId: string): Promise<LandedStatus> {
  const landed = await checkHcsTxLandedBounded(txId, "mainnet");
  if (landed !== "unknown") return landed;
  try {
    const headMs = await getMirrorHeadTimestampMs();
    if (isMirrorBeyondTxWindow(txId, headMs, MIRROR_CATCHUP_MARGIN_MS)) return "expired";
  } catch {
    // No signal — unknown stays unknown.
  }
  return "unknown";
}

/**
 * Check whether an HCS transaction actually executed on-chain via the
 * mirror node. Recovery path when the wallet goes silent after the user
 * approves — we generated the txId ourselves, so we can look it up.
 */
async function checkHcsTxLanded(
  txId: string,
  network: "mainnet",
): Promise<"success" | "failed" | "unknown"> {
  try {
    const base = "https://mainnet.mirrornode.hedera.com/api/v1";
    // txId is the SDK @ form (0.0.x@seconds.nanos); the mirror only
    // answers the dash form, so normalize before querying.
    const res = await fetch(`${base}/transactions/${encodeURIComponent(toMirrorTxId(txId))}`);
    if (!res.ok) return "unknown";
    const data = (await res.json()) as { transactions?: Array<{ result?: string }> };
    const result = data.transactions?.[0]?.result;
    if (result === "SUCCESS") return "success";
    if (result) return "failed";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Submit a message to an HCS topic, signed by the user's wallet.
 *
 * @param topicId - The HCS topic ID (e.g. "0.0.12345")
 * @param message - The message object (will be JSON-stringified)
 * @param signer - Wallet signer interface
 */
export async function submitHcsViaWallet(
  topicId: string,
  message: object,
  signer: WalletSigner,
): Promise<HcsSubmitResult> {
  // Dynamic import to keep the SDK out of the initial bundle.
  const {
    Client,
    TopicId,
    TopicMessageSubmitTransaction,
    AccountId,
    TransactionId,
  } = await import("@hiero-ledger/sdk");

  const networkClient = Client.forMainnet(); // mainnet only — no testnet

  try {
    const accountId = AccountId.fromString(signer.accountId);
    // Fail fast before the user signs and pays: oversized messages are
    // auto-chunked by the SDK, which our server never reassembles.
    const messageJson = assertHcsMessageFits(message);
    // Fail fast on a dead WalletConnect session (shared check with
    // lib/tx.ts) — otherwise the wallet prompt never appears and the user
    // stares at "sending…" until the 30s timeout. Fail-open when the
    // caller passes no connector.
    if (
      signer.walletConnector !== undefined &&
      !isWalletSessionAlive(signer.walletConnector)
    ) {
      throw new Error(
        "Wallet session expired — disconnect and reconnect your wallet, then try again.",
      );
    }
    // HCS submits share the pending-intent ledger (kind "hcs:…") so an
    // interrupted submit can't silently duplicate: re-ask the mirror about
    // any unanswered HCS intent from this account first, and refuse while
    // one is still unknown. HCS intents never gate contract writes (see
    // isHcsIntentKind) — an unconfirmed post must not block a payment.
    await reconcilePendingIntents(checkHcsLandedStatus);
    const blockedHcs = listPendingIntents().filter(
      (i) => i.account === accountId.toString() && isHcsIntentKind(i.kind),
    );
    if (blockedHcs.length > 0) throw new UnresolvedIntentError(blockedHcs);
    const tx = new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(messageJson);

    // Freeze with the public client so the wallet can sign (HIP-820).
    tx.setTransactionId(TransactionId.generate(accountId));
    tx.freezeWith(networkClient);

    const txId = tx.transactionId?.toString() ?? "";
    const txBase64 = Buffer.from(tx.toBytes()).toString("base64");
    // Persist the intent before the wallet signs — same pattern as
    // lib/tx.ts. Cleared on definitive outcomes; unknown outcomes stay
    // stored so the next submit reconciles instead of double-paying.
    const msgKind = (message as { kind?: unknown }).kind;
    savePendingIntent({
      txId,
      kind: "hcs:submit",
      label:
        typeof msgKind === "string" && msgKind
          ? `Town Hall ${msgKind}`
          : "Town Hall message",
      account: accountId.toString(),
      createdAt: Date.now(),
    });

    // The wallet response sometimes never arrives even though the user
    // approved and the HCS message was submitted. Without a timeout the UI
    // hangs on "submitting" forever while the user's money is already
    // spent — the worst possible UX. Race the wallet call against a
    // timeout, then check whether the transaction actually landed.
    //
    // 30s (not 90s): a healthy HashPack prompts within seconds. Silence
    // means a stale WalletConnect session (HashPack #291) — fail with a
    // reconnect message instead of hanging.
    const WALLET_TIMEOUT_MS = 30_000;
    let walletResponded = false;
    try {
      await Promise.race([
        (async () => {
          await signer.signAndExecuteTransaction({
            signerAccountId: `hedera:${signer.network}:${accountId.toString()}`,
            transactionList: txBase64,
          });
          walletResponded = true;
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("WALLET_TIMEOUT")), WALLET_TIMEOUT_MS),
        ),
      ]);
    } catch (e) {
      if (e instanceof Error && e.message === "WALLET_TIMEOUT" && !walletResponded) {
        const landed = await checkHcsTxLandedBounded(txId, signer.network);
        if (landed === "success") {
          removePendingIntent(txId);
          return { transactionId: txId };
        }
        if (landed === "failed") {
          removePendingIntent(txId);
          throw new Error("The transaction failed on-chain. No message was posted.");
        }
        // Not on-chain after 30s of wallet silence: the prompt never appeared
        // (stale WalletConnect session). Tell the user how to fix it. The
        // intent stays stored — the next submit reconciles it instead of
        // silently posting (and charging for) a duplicate.
        throw new Error(STALE_CONNECTION_COPY);
      }
      // A rejected signature is never broadcast — clear the intent so a
      // routine "decline" doesn't block later submits (same as tx.ts H1).
      if (isWalletRejection(e)) {
        removePendingIntent(txId);
      }
      throw e;
    }

    return { transactionId: txId };
  } finally {
    networkClient.close();
  }
}

/** Fetch Town Hall topic IDs from the server (public, no auth needed). */
export async function getTownhallTopics(): Promise<Record<string, string | null>> {
  // Bounded: without a timeout a hung /api/townhall/topics stalls the HCS
  // submit flow before the wallet prompt ever appears.
  const res = await fetchWithTimeout("/api/townhall/topics", 10_000);
  if (!res.ok) throw new Error("Failed to fetch Town Hall topics");
  return res.json();
}
