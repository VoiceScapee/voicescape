"use client";

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
  network: "mainnet" | "testnet" | "previewnet";
}

/**
 * Check whether an HCS transaction actually executed on-chain via the
 * mirror node. Recovery path when the wallet goes silent after the user
 * approves — we generated the txId ourselves, so we can look it up.
 */
async function checkHcsTxLanded(
  txId: string,
  network: "mainnet" | "testnet" | "previewnet",
): Promise<"success" | "failed" | "unknown"> {
  try {
    const base =
      network === "mainnet"
        ? "https://mainnet.mirrornode.hedera.com/api/v1"
        : network === "testnet"
          ? "https://testnet.mirrornode.hedera.com/api/v1"
          : "https://previewnet.mirrornode.hedera.com/api/v1";
    const res = await fetch(`${base}/transactions/${encodeURIComponent(txId)}`);
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

  const networkClient =
    signer.network === "mainnet"
      ? Client.forMainnet()
      : signer.network === "previewnet"
        ? Client.forPreviewnet()
        : Client.forTestnet();

  try {
    const accountId = AccountId.fromString(signer.accountId);
    // Fail fast before the user signs and pays: oversized messages are
    // auto-chunked by the SDK, which our server never reassembles.
    const messageJson = assertHcsMessageFits(message);
    const tx = new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(messageJson);

    // Freeze with the public client so the wallet can sign (HIP-820).
    tx.setTransactionId(TransactionId.generate(accountId));
    tx.freezeWith(networkClient);

    const txId = tx.transactionId?.toString() ?? "";
    const txBase64 = Buffer.from(tx.toBytes()).toString("base64");

    // The wallet response sometimes never arrives even though the user
    // approved and the HCS message was submitted. Without a timeout the UI
    // hangs on "submitting" forever while the user's money is already
    // spent — the worst possible UX. Race the wallet call against a
    // timeout, then check whether the transaction actually landed.
    const WALLET_TIMEOUT_MS = 90_000;
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
        const landed = await checkHcsTxLanded(txId, signer.network);
        if (landed === "success") return { transactionId: txId };
        if (landed === "failed") {
          throw new Error("The transaction failed on-chain. No message was posted.");
        }
        throw new Error(
          "Your wallet didn't respond in time. The message may still have been posted — " +
          "check the chat before sending again to avoid duplicates.",
        );
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
  const res = await fetch("/api/townhall/topics");
  if (!res.ok) throw new Error("Failed to fetch Town Hall topics");
  return res.json();
}
