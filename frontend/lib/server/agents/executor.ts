/**
 * Voicescape Agent Executor — natural-language to unsigned Hedera transactions.
 *
 * This is the server-side counterpart to the Hedera Agent Kit's RETURN_BYTES
 * mode: instead of an LLM (which would require a paid API key), we use a
 * deterministic rule-based parser for the three supported operations. The
 * server NEVER signs — it builds the transaction, freezes it with the
 * user's account as payer, and returns the serialized bytes. The human
 * signs via their wallet (HashConnect); nothing moves without their
 * explicit approval.
 *
 * Supported operations:
 *  - TIP: "tip 5 HBAR to @brandon" → TransferTransaction (HBAR)
 *  - POST: "post 'hello' to the forum" → TopicMessageSubmitTransaction (HCS)
 *  - BUY: "buy listing <ref> from <seller>" → ContractExecuteTransaction (buyListing)
 *
 * Safety (enforced here, not just documented):
 *  - Max 100 HBAR per operation.
 *  - Content safety filter on all HCS messages (same filter as town hall).
 *  - No AUTONOMOUS mode — the server has no signing key for user funds.
 *
 * Next-free: no Next.js imports, so this is directly unit-testable.
 */

import {
  AccountId,
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
  TopicId,
  TopicMessageSubmitTransaction,
  TransactionId,
  TransferTransaction,
} from "@hashgraph/sdk";
import { checkContent } from "../townhall/content-filter";

/** Max HBAR per single agent operation — prevents accidents, not a spending cap. */
export const MAX_HBAR_PER_OP = 100;

/** Rate limit: 10 execute requests per wallet per hour. */
export const EXECUTE_RATE_LIMIT = 10;
export const EXECUTE_RATE_WINDOW_MS = 60 * 60 * 1000;

export type AgentOperation =
  | { kind: "tip"; amountHbar: number; targetUsername: string }
  | { kind: "post"; message: string; destination: "forum" | "chat" }
  | { kind: "buy"; listingRef: string; sellerAddress: string; priceHbar: number };

export type ParseResult =
  | { ok: true; op: AgentOperation }
  | { ok: false; error: string };

/**
 * Deterministic natural-language parser for the three supported operations.
 * No LLM — patterns are explicit so behavior is predictable and testable.
 */
export function parseInstruction(instruction: string): ParseResult {
  const text = instruction.trim();
  if (!text) return { ok: false, error: "instruction is empty" };
  if (text.length > 500) return { ok: false, error: "instruction too long (max 500 chars)" };

  // --- TIP: "tip 5 HBAR to @brandon", "send 10 hbar to @alice", "tip @bob 2.5" ---
  const tipPatterns = [
    /tip\s+(\d+(?:\.\d+)?)\s*(?:hbar)?\s+to\s+@?([a-z0-9][a-z0-9-]{1,30}[a-z0-9])/i,
    /send\s+(\d+(?:\.\d+)?)\s*hbar\s+to\s+@?([a-z0-9][a-z0-9-]{1,30}[a-z0-9])/i,
    /tip\s+@?([a-z0-9][a-z0-9-]{1,30}[a-z0-9])\s+(\d+(?:\.\d+)?)\s*(?:hbar)?/i,
  ];
  for (const re of tipPatterns) {
    const m = text.match(re);
    if (m) {
      // tipPatterns[2] has groups in (username, amount) order; others are (amount, username).
      const amountStr = re === tipPatterns[2] ? m[2] : m[1];
      const username = (re === tipPatterns[2] ? m[1] : m[2]).toLowerCase();
      const amount = Number(amountStr);
      if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: "tip amount must be a positive number" };
      }
      if (amount > MAX_HBAR_PER_OP) {
        return { ok: false, error: `tip amount exceeds the ${MAX_HBAR_PER_OP} HBAR per-operation limit` };
      }
      return { ok: true, op: { kind: "tip", amountHbar: amount, targetUsername: username } };
    }
  }

  // --- POST: "post 'hello world' to the forum", 'post to chat: hello', "say 'hi' in the forum" ---
  const postPatterns: Array<{ re: RegExp; dest: "forum" | "chat" }> = [
    { re: /post\s+['"]([^'"]{1,450})['"]\s+to\s+(?:the\s+)?forum/i, dest: "forum" },
    { re: /post\s+['"]([^'"]{1,450})['"]\s+to\s+(?:the\s+)?chat/i, dest: "chat" },
    { re: /post\s+to\s+(?:the\s+)?forum\s*:\s*(.{1,450})/i, dest: "forum" },
    { re: /post\s+to\s+(?:the\s+)?chat\s*:\s*(.{1,450})/i, dest: "chat" },
    { re: /say\s+['"]([^'"]{1,450})['"]\s+in\s+(?:the\s+)?forum/i, dest: "forum" },
    { re: /say\s+['"]([^'"]{1,450})['"]\s+in\s+(?:the\s+)?chat/i, dest: "chat" },
  ];
  for (const { re, dest } of postPatterns) {
    const m = text.match(re);
    if (m) {
      const message = m[1].trim();
      if (!message) return { ok: false, error: "post message is empty" };
      const check = checkContent(message, "agent post");
      if (!check.allowed) {
        return { ok: false, error: `message blocked by content filter: ${check.reason}` };
      }
      return { ok: true, op: { kind: "post", message, destination: dest } };
    }
  }

  // --- BUY: "buy listing <ref> from 0x<seller> for 5 HBAR" ---
  const buyRe = /(?:buy|purchase)\s+(?:listing\s+)?(\S{1,80})\s+from\s+(0x[0-9a-fA-F]{40})\s+for\s+(\d+(?:\.\d+)?)\s*(?:hbar)?/i;
  const buyMatch = text.match(buyRe);
  if (buyMatch) {
    const price = Number(buyMatch[3]);
    if (!Number.isFinite(price) || price <= 0) {
      return { ok: false, error: "listing price must be a positive number" };
    }
    if (price > MAX_HBAR_PER_OP) {
      return { ok: false, error: `listing price exceeds the ${MAX_HBAR_PER_OP} HBAR per-operation limit` };
    }
    return {
      ok: true,
      op: {
        kind: "buy",
        listingRef: buyMatch[1],
        sellerAddress: buyMatch[2].toLowerCase(),
        priceHbar: price,
      },
    };
  }

  return {
    ok: false,
    error:
      "could not understand instruction. Try: \"tip 5 HBAR to @username\", " +
      "\"post 'hello' to the forum\", or \"buy listing <ref> from 0x<seller> for 5 HBAR\".",
  };
}

export interface BuildContext {
  /** Payer's Hedera account id (0.0.x) — from the verified session. */
  payerAccountId: string;
  /** Resolved tip recipient account id (0.0.x). */
  tipRecipientAccountId?: string;
  /** HCS topic id for post destination. */
  topicId?: string;
  /** Tips contract EVM address (0x...). */
  tipsContractAddress?: string;
  /** Hedera network for the client. */
  network: "mainnet" | "testnet";
}

export interface BuiltTransaction {
  /** Base64-encoded frozen unsigned transaction bytes (RETURN_BYTES). */
  unsignedTxBytes: string;
  /** Human-readable description for the signing prompt. */
  description: string;
  /** Hedera transaction id (for tracking). */
  transactionId: string;
  /** Transaction type label. */
  txType: string;
}

function buildClient(network: "mainnet" | "testnet"): Client {
  return network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
}

function freezeForPayer(
  tx: TransferTransaction | TopicMessageSubmitTransaction | ContractExecuteTransaction,
  ctx: BuildContext,
): { bytesB64: string; txId: string } {
  const client = buildClient(ctx.network);
  try {
    const payer = AccountId.fromString(ctx.payerAccountId);
    // Fixed valid-start for determinism in tests; production uses current time.
    const txId = TransactionId.generate(payer);
    tx.setTransactionId(txId);
    // freezeWith signs nothing — it finalizes the tx body so the wallet can sign.
    tx.freezeWith(client);
    const bytes = tx.toBytes();
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return { bytesB64: btoa(binary), txId: txId.toString() };
  } finally {
    client.close();
  }
}

/** Build an unsigned HBAR tip transaction (RETURN_BYTES). */
export function buildTipTransaction(
  op: Extract<AgentOperation, { kind: "tip" }>,
  ctx: BuildContext,
): BuiltTransaction {
  if (!ctx.tipRecipientAccountId) throw new Error("tip recipient account id is required");
  const tx = new TransferTransaction()
    .addHbarTransfer(ctx.payerAccountId, new Hbar(-op.amountHbar))
    .addHbarTransfer(ctx.tipRecipientAccountId, new Hbar(op.amountHbar))
    .setTransactionMemo(`Voicescape agent tip to @${op.targetUsername}`.slice(0, 100));
  const { bytesB64, txId } = freezeForPayer(tx, ctx);
  return {
    unsignedTxBytes: bytesB64,
    description: `Tip ${op.amountHbar} HBAR to @${op.targetUsername}`,
    transactionId: txId,
    txType: "TransferTransaction",
  };
}

/** Build an unsigned HCS post transaction (RETURN_BYTES). */
export function buildPostTransaction(
  op: Extract<AgentOperation, { kind: "post" }>,
  ctx: BuildContext,
): BuiltTransaction {
  if (!ctx.topicId) throw new Error("topic id is required for posts");
  const tx = new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(ctx.topicId))
    .setMessage(
      JSON.stringify({
        kind: "agent-post",
        destination: op.destination,
        message: op.message,
        timestamp: new Date().toISOString(),
      }),
    );
  const { bytesB64, txId } = freezeForPayer(tx, ctx);
  return {
    unsignedTxBytes: bytesB64,
    description: `Post to ${op.destination}: "${op.message.slice(0, 80)}${op.message.length > 80 ? "…" : ""}"`,
    transactionId: txId,
    txType: "TopicMessageSubmitTransaction",
  };
}

/** Build an unsigned marketplace purchase transaction (RETURN_BYTES). */
export function buildBuyTransaction(
  op: Extract<AgentOperation, { kind: "buy" }>,
  ctx: BuildContext,
): BuiltTransaction {
  if (!ctx.tipsContractAddress) throw new Error("tips contract address is required");
  // Price already validated by the parser; double-check here for defense in depth.
  if (op.priceHbar > MAX_HBAR_PER_OP) {
    throw new Error(`listing price exceeds the ${MAX_HBAR_PER_OP} HBAR per-operation limit`);
  }
  // ContractId from EVM address (same as lib/tx.ts hederaContractId).
  if (!/^0x[0-9a-fA-F]{40}$/.test(ctx.tipsContractAddress)) {
    throw new Error("tips contract address is invalid");
  }
  const contractId = ContractId.fromEvmAddress(0, 0, ctx.tipsContractAddress);
  const tx = new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(300_000)
    .setFunction(
      "buyListing",
      new ContractFunctionParameters().addAddress(op.sellerAddress).addString(op.listingRef),
    )
    .setPayableAmount(new Hbar(op.priceHbar));
  const { bytesB64, txId } = freezeForPayer(tx, ctx);
  return {
    unsignedTxBytes: bytesB64,
    description: `Buy listing "${op.listingRef}" for ${op.priceHbar} HBAR (98% to seller, 2% to treasury)`,
    transactionId: txId,
    txType: "ContractExecuteTransaction",
  };
}
