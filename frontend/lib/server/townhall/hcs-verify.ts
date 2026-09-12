/**
 * Server-side verification of user-submitted HCS transactions.
 *
 * In the user-signed architecture, the client submits the HCS message
 * directly via their wallet, then sends the transaction ID + message to
 * the server. The server verifies via the mirror node that:
 * 1. The transaction exists, was successful, and is a CONSENSUSSUBMITMESSAGE
 * 2. It was submitted to the expected topic (via entity_id)
 * 3. The payer matches the authenticated user's account
 *
 * The message content itself is validated by the handlers (auth, filters,
 * business rules). The mirror node is the source of truth for the
 * transaction; the client cannot forge a valid txId for someone else's
 * account.
 */

import { mirrorBaseUrl } from "./topics";

interface MirrorTransaction {
  transaction_id: string;
  name: string;
  result: string;
  entity_id?: string; // Topic ID for CONSENSUSSUBMITMESSAGE
  payer_account_id?: string;
  consensus_timestamp?: string;
  transfers?: Array<{ account: string; amount: number }>;
}

interface MirrorTransactionResponse {
  transactions?: MirrorTransaction[];
}

interface MirrorTopicMessage {
  consensus_timestamp: string;
  message: string; // base64-encoded
  sequence_number: number;
}

interface MirrorTopicMessagesResponse {
  messages?: MirrorTopicMessage[];
}

export interface VerifiedHcsTx {
  /** The HCS topic ID the message was submitted to. */
  topicId: string;
  /** The payer's Hedera account ID (0.0.x). */
  payer: string;
  /** The decoded HCS message content (JSON string). */
  message: string;
  /** The HCS sequence number of the message. */
  sequenceNumber: number;
}

/**
 * Verify a user-submitted HCS transaction via the mirror node.
 *
 * @param txId - Hedera transaction ID (e.g. "0.0.1234@1234567890.123456789")
 * @param expectedTopicId - The topic the message should have been submitted to
 * @param expectedPayer - The authenticated user's account ID (0.0.x)
 * @returns The verified tx details, or null if verification fails
 */
export async function verifyHcsTransaction(
  txId: string,
  expectedTopicId: string,
  expectedPayer: string,
): Promise<VerifiedHcsTx | null> {
  if (!txId || typeof txId !== "string") return null;
  if (!expectedTopicId || !expectedPayer) return null;

  // Normalize to mirror node format: 0.0.x@seconds.nanos
  const normalized = txId.trim().replace(/-/g, (m, offset, str) => {
    // Only replace dashes that are separators, not in the account ID
    // Format: 0.0.1234-1234567890-123456789 -> 0.0.1234@1234567890.123456789
    return offset > 6 ? (str[offset - 1] === "@" ? "." : "@") : m;
  });
  // Simpler: handle both formats explicitly
  let mirrorTxId: string;
  const atForm = /^0\.0\.\d+@\d+\.\d+$/.test(txId.trim());
  const dashForm = /^0\.0\.\d+-\d+-\d+$/.test(txId.trim());
  if (atForm) {
    mirrorTxId = txId.trim();
  } else if (dashForm) {
    const parts = txId.trim().split("-");
    mirrorTxId = `${parts[0]}@${parts[1]}.${parts[2]}`;
  } else {
    return null;
  }

  try {
    const url = `${mirrorBaseUrl()}/api/v1/transactions/${mirrorTxId}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = (await res.json()) as MirrorTransactionResponse;
    const tx = data.transactions?.[0];
    if (!tx) return null;

    // Must be a successful HCS message submit
    if (tx.name !== "CONSENSUSSUBMITMESSAGE") return null;
    if (tx.result !== "SUCCESS") return null;

    // Must be to the expected topic
    if (tx.entity_id !== expectedTopicId) return null;

    // Payer must match the authenticated user
    // The mirror node provides payer_account_id; fall back to transfers
    let payer: string | null = tx.payer_account_id ?? null;
    if (!payer && tx.transfers) {
      // The payer is the account with the negative HTS transfer for the fee,
      // but simpler: find the account that paid (negative amount, not the fee collector)
      // Actually, the first transfer with a negative amount that's not tiny is likely the payer.
      // For robustness, we use payer_account_id when available.
    }
    if (!payer) return null;
    if (payer !== expectedPayer) return null;

    // Fetch the actual on-chain message content for content-bound verification.
    // The transaction's consensus_timestamp lets us query the exact message.
    const consensusTimestamp = tx.consensus_timestamp;
    if (!consensusTimestamp) return null;

    try {
      const msgUrl = `${mirrorBaseUrl()}/api/v1/topics/${expectedTopicId}/messages?timestamp=${consensusTimestamp}`;
      const msgRes = await fetch(msgUrl);
      if (!msgRes.ok) return null;
      const msgData = (await msgRes.json()) as MirrorTopicMessagesResponse;
      const msg = msgData.messages?.[0];
      if (!msg || !msg.message) return null;

      // Decode the base64 message content
      const messageJson = Buffer.from(msg.message, "base64").toString("utf-8");

      return {
        topicId: tx.entity_id,
        payer,
        message: messageJson,
        sequenceNumber: msg.sequence_number,
      };
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}
