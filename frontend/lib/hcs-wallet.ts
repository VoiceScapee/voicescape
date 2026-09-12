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

    await signer.signAndExecuteTransaction({
      signerAccountId: `hedera:${signer.network}:${accountId.toString()}`,
      transactionList: txBase64,
    });

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
