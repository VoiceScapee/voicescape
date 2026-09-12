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
 *  - TIP: "tip 5 HBAR to @brandon" → ContractExecuteTransaction (tipPage; 98/2 split)
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
  TopicCreateTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { checkContent } from "../townhall/content-filter";

/** Max HBAR per single agent operation — prevents accidents, not a spending cap. */
export const MAX_HBAR_PER_OP = 100;

/**
 * Max HCS message size the executor will build. A single HCS chunk carries
 * 1024 bytes; larger messages are auto-chunked by the SDK into multiple
 * transactions, which our server never reassembles. Fail before the user
 * signs so they never pay fees for a message that can't be accepted.
 */
export const MAX_HCS_MESSAGE_BYTES = 900;

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
  tx: TransferTransaction | TopicMessageSubmitTransaction | ContractExecuteTransaction | TopicCreateTransaction,
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

/** Build an unsigned Tips-contract tip transaction (RETURN_BYTES).
 *
 * Routes through VoicescapeTips.tipPage(username) so the atomic 98/2
 * recipient/treasury split is enforced on-chain — never a raw transfer.
 */
export function buildTipTransaction(
  op: Extract<AgentOperation, { kind: "tip" }>,
  ctx: BuildContext,
): BuiltTransaction {
  if (!ctx.tipsContractAddress) throw new Error("tips contract address is required");
  // Address shape validated here for defense in depth (also checked at the route).
  if (!/^0x[0-9a-fA-F]{40}$/.test(ctx.tipsContractAddress)) {
    throw new Error("tips contract address is invalid");
  }
  const contractId = ContractId.fromEvmAddress(0, 0, ctx.tipsContractAddress);
  const tx = new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(300_000)
    .setFunction("tipPage", new ContractFunctionParameters().addString(op.targetUsername))
    .setPayableAmount(new Hbar(op.amountHbar))
    .setTransactionMemo(`Voicescape agent tip to @${op.targetUsername}`.slice(0, 100));
  const { bytesB64, txId } = freezeForPayer(tx, ctx);
  return {
    unsignedTxBytes: bytesB64,
    description: `Tip ${op.amountHbar} HBAR to @${op.targetUsername} (98% to owner, 2% to treasury)`,
    transactionId: txId,
    txType: "ContractExecuteTransaction",
  };
}

/** Build an unsigned HCS post transaction (RETURN_BYTES). */
export function buildPostTransaction(
  op: Extract<AgentOperation, { kind: "post" }>,
  ctx: BuildContext,
): BuiltTransaction {
  if (!ctx.topicId) throw new Error("topic id is required for posts");
  const postJson = JSON.stringify({
    kind: "agent-post",
    destination: op.destination,
    message: op.message,
    timestamp: new Date().toISOString(),
  });
  if (new TextEncoder().encode(postJson).length > MAX_HCS_MESSAGE_BYTES) {
    throw new Error(
      `Post is too long for a single HCS message (max ${MAX_HCS_MESSAGE_BYTES} bytes) — please shorten it.`,
    );
  }
  const tx = new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(ctx.topicId))
    .setMessage(postJson);
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

/* ------------------------------------------------------------------ */
/* HCS-10 topic transactions (built directly with @hiero-ledger/sdk) */
/* ------------------------------------------------------------------ */

/**
 * Build unsigned HCS-10 inbound + outbound topic creation transactions
 * (RETURN_BYTES) using @hiero-ledger/sdk directly.
 *
 * HCS-10 memo format (per the HCS-10 spec):
 * - Inbound topic:  hcs-10:0:{ttl}:0:{accountId}  (receives connection requests)
 * - Outbound topic: hcs-10:0:{ttl}:1              (records connection activity)
 * ttl 0 = no topic expiry (agent topics stay alive).
 *
 * The agent signs both with its own key, submits them, then uses the
 * resulting topic ids to build the HCS-10 registry registration
 * (see `buildHcs10RegistryRegisterTx` from the SDK — the agent calls it
 * directly once it knows its inbound topic id).
 *
 * The server never touches keys: these are frozen unsigned bytes, same
 * pattern as buildRegisterTransaction.
 */
export function buildHcs10TopicTransactions(ctx: BuildContext): {
  inbound: BuiltTransaction;
  outbound: BuiltTransaction;
} {
  if (!/^0\.0\.\d+$/.test(ctx.payerAccountId)) {
    throw new Error("payerAccountId must be a 0.0.x account id");
  }
  // Built directly with @hiero-ledger/sdk: the standards-sdk builders
  // return old-SDK (@hashgraph/sdk v2) transaction objects whose
  // freezeWith() is incompatible with hiero v3 clients.
  const inboundTx = new TopicCreateTransaction()
    .setTopicMemo(`hcs-10:0:0:0:${ctx.payerAccountId}`);
  const outboundTx = new TopicCreateTransaction()
    .setTopicMemo("hcs-10:0:0:1");

  const inboundFrozen = freezeForPayer(inboundTx, ctx);
  const outboundFrozen = freezeForPayer(outboundTx, ctx);
  return {
    inbound: {
      unsignedTxBytes: inboundFrozen.bytesB64,
      description: "Create HCS-10 inbound topic (receives connection requests)",
      transactionId: inboundFrozen.txId,
      txType: "TopicCreateTransaction",
    },
    outbound: {
      unsignedTxBytes: outboundFrozen.bytesB64,
      description: "Create HCS-10 outbound topic (records connection activity)",
      transactionId: outboundFrozen.txId,
      txType: "TopicCreateTransaction",
    },
  };
}

/* ------------------------------------------------------------------ */
/* Agent onboarding: unsigned registerPage transaction (RETURN_BYTES)  */
/* ------------------------------------------------------------------ */

/** Rate limit: 3 onboardings per wallet per day. */
export const ONBOARD_RATE_LIMIT = 3;
export const ONBOARD_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Gas for the Registry registerPage call. */
export const REGISTER_GAS = 600_000;

export interface RegisterPageOperation {
  username: string;
  /** IPFS CID of the pinned agent page. */
  ipfsHash: string;
  /** 0 = human, 1 = agent. */
  ownerType: 0 | 1;
  /** 0x EVM address of the operator (the Registry requires 0x form). */
  operator: string;
  /** On-chain purpose disclosure (1-500 chars). */
  purpose: string;
}

export interface RegisterBuildContext extends BuildContext {
  registryContractAddress: string;
}

/**
 * Build an unsigned Registry `registerPage` transaction (RETURN_BYTES).
 *
 * Validates the Registry address, username, CID, operator, and purpose,
 * then builds the contract call with the CID baked in. The agent signs
 * with its own Hedera key and submits — the server never signs.
 */
export function buildRegisterTransaction(
  op: RegisterPageOperation,
  ctx: RegisterBuildContext,
): BuiltTransaction {
  if (!ctx.registryContractAddress || !/^0x[0-9a-fA-F]{40}$/.test(ctx.registryContractAddress)) {
    throw new Error("invalid registry contract address");
  }
  if (!op.username || op.username.length < 3 || op.username.length > 24) {
    throw new Error("invalid username");
  }
  if (!op.ipfsHash || op.ipfsHash.trim() === "") {
    throw new Error("ipfsHash (CID) is required");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(op.operator)) {
    throw new Error("operator must be a 0x EVM address");
  }
  if (!op.purpose || op.purpose.length > 500) {
    throw new Error("purpose is required (1-500 chars)");
  }
  if (op.ownerType !== 0 && op.ownerType !== 1) {
    throw new Error("ownerType must be 0 (human) or 1 (agent)");
  }

  const contractId = ContractId.fromEvmAddress(0, 0, ctx.registryContractAddress);
  const params = new ContractFunctionParameters()
    .addString(op.username)
    .addString(op.ipfsHash)
    .addUint8(op.ownerType)
    .addAddress(op.operator)
    .addString(op.purpose);

  const tx = new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(REGISTER_GAS)
    .setFunction("registerPage", params);

  const { bytesB64, txId } = freezeForPayer(tx, ctx);
  return {
    unsignedTxBytes: bytesB64,
    description: `Register agent page @${op.username} on Voicescape (ownerType=agent)`,
    transactionId: txId,
    txType: "ContractExecuteTransaction",
  };
}
