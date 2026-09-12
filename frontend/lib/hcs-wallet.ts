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
    const tx = new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(JSON.stringify(message));

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
