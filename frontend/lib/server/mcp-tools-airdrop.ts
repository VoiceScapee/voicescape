/**
 * Voicescape MCP server — HIP-904 frictionless airdrop tools.
 *
 * HIP-904 (live on mainnet): TokenAirdrop distributes tokens/NFTs to
 * accounts WITHOUT pre-association. Receivers lacking an association
 * slot get a PENDING airdrop they can claim (TokenClaimAirdrop); the
 * sender can cancel unclaimed ones (TokenCancelAirdrop). All transfer
 * fees — including custom fees, royalties, and the rent for any
 * auto-renewal slot the airdrop occupies — are charged to the SENDER.
 *
 * Two tools:
 *   1. prepare_airdrop — build the UNSIGNED TokenAirdropTransaction
 *      bytes for the sender's own key to sign. The sender pays everything;
 *      the platform pays nothing and takes nothing.
 *   2. check_pending_airdrops — read-only: list an account's pending
 *      airdrops from the mirror node (what's waiting to be claimed).
 *
 * NON-CUSTODIAL INVARIANT: the server never signs, never holds keys,
 * never submits. The sender signs the prepared bytes with their own
 * Hedera key.
 *
 * USE CASES: NFT drop editions to followers (no per-buyer association
 * step), "first 100 followers get a collectible" campaigns, agent
 * welcome packs.
 */

import {
  AccountId,
  Client,
  NftId,
  TokenId,
  TokenAirdropTransaction,
  TransactionId,
} from "@hiero-ledger/sdk";
import { MIRROR_BASE } from "./mcp-tools";

type FetchFn = typeof fetch;

const ACCOUNT_RE = /^0\.0\.\d+$/;
const TOKEN_RE = /^0\.0\.\d+$/;
/** Cap recipients per call — keeps the transaction small and reviewable. */
const MAX_RECIPIENTS = 50;

async function fetchJson(
  fetchFn: FetchFn,
  url: string,
): Promise<{ ok: boolean; body: any }> {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return { ok: false, body: null };
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, body: null };
  }
}

export interface AirdropRecipient {
  /** Recipient 0.0.x account id. */
  account_id: string;
  /** Fungible amount in the token's smallest unit (as a string). */
  amount?: string;
  /** NFT serial numbers to send (NFT drops). */
  serial_numbers?: number[];
}

export interface PrepareAirdropArgs {
  /** Sender's 0.0.x account id — must hold the tokens; pays all fees. */
  sender_account_id: string;
  /** Token being airdropped (fungible or NFT collection). */
  token_id: string;
  recipients: AirdropRecipient[];
}

export interface PreparedAirdrop {
  sender_account_id: string;
  token_id: string;
  kind: "fungible" | "nft";
  transfers: Array<{ recipient: string; amount?: string; serial_numbers?: number[] }>;
  /** Base64 frozen TokenAirdropTransaction — UNSIGNED. The sender signs this. */
  unsigned_tx_base64: string;
  warnings: string[];
  instructions: string;
}

/**
 * Build an unsigned HIP-904 airdrop for the sender's own key to sign.
 * Best-effort pre-checks (sender ownership/balance) run against the
 * mirror node; they fail OPEN with a warning so a mirror hiccup never
 * blocks a valid airdrop.
 */
export async function prepareAirdropTool(
  args: PrepareAirdropArgs,
  fetchFn: FetchFn = fetch,
): Promise<PreparedAirdrop | { error: string }> {
  const sender = (args.sender_account_id ?? "").toString().trim();
  if (!ACCOUNT_RE.test(sender)) {
    return { error: `sender_account_id "${args.sender_account_id}" is not a 0.0.x account id` };
  }
  const tokenId = (args.token_id ?? "").toString().trim();
  if (!TOKEN_RE.test(tokenId)) {
    return { error: `token_id "${args.token_id}" is not a 0.0.x token id` };
  }
  const recipients = Array.isArray(args.recipients) ? args.recipients : [];
  if (recipients.length === 0) {
    return { error: "recipients is empty — at least one recipient is required" };
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return {
      error: `too many recipients (${recipients.length}) — max ${MAX_RECIPIENTS} per call; split into batches`,
    };
  }

  // Normalize + validate: every recipient is EITHER fungible-amount OR
  // nft-serials, never both, never neither.
  const warnings: string[] = [];
  let kind: "fungible" | "nft" | null = null;
  const transfers: PreparedAirdrop["transfers"] = [];
  for (const r of recipients) {
    const accountId = (r?.account_id ?? "").toString().trim();
    if (!ACCOUNT_RE.test(accountId)) {
      return { error: `recipient account_id "${r?.account_id}" is not a 0.0.x account id` };
    }
    const hasAmount = r?.amount !== undefined && r?.amount !== null && `${r.amount}`.trim() !== "";
    const serials = Array.isArray(r?.serial_numbers) ? r.serial_numbers : [];
    if (hasAmount && serials.length > 0) {
      return { error: `recipient ${accountId}: give either amount OR serial_numbers, not both` };
    }
    if (hasAmount) {
      if (kind === "nft") {
        return { error: "mixed transfer kinds — one airdrop call handles fungible OR nfts, not both" };
      }
      kind = "fungible";
      let amount: bigint;
      try {
        amount = BigInt(`${r.amount}`.trim());
      } catch {
        return { error: `recipient ${accountId}: amount "${r.amount}" is not an integer` };
      }
      if (amount <= 0n) {
        return { error: `recipient ${accountId}: amount must be positive` };
      }
      transfers.push({ recipient: accountId, amount: amount.toString() });
    } else if (serials.length > 0) {
      if (kind === "fungible") {
        return { error: "mixed transfer kinds — one airdrop call handles fungible OR nfts, not both" };
      }
      kind = "nft";
      for (const s of serials) {
        if (!Number.isInteger(s) || s <= 0) {
          return { error: `recipient ${accountId}: serial ${s} is not a positive integer` };
        }
      }
      const unique = [...new Set(serials)];
      if (unique.length !== serials.length) {
        return { error: `recipient ${accountId}: duplicate serial numbers` };
      }
      transfers.push({ recipient: accountId, serial_numbers: unique });
    } else {
      return { error: `recipient ${accountId}: give an amount (fungible) or serial_numbers (nft)` };
    }
  }

  // Best-effort pre-checks against the mirror node (fail open).
  if (kind === "nft") {
    const needed = new Map<string, number[]>();
    for (const t of transfers) {
      needed.set(t.recipient, t.serial_numbers!);
    }
    const allSerials = [...new Set(transfers.flatMap((t) => t.serial_numbers!))];
    const { ok, body } = await fetchJson(
      fetchFn,
      `${MIRROR_BASE}/accounts/${sender}/nfts?token.id=${tokenId}&limit=100`,
    );
    if (ok && body && Array.isArray(body.nfts)) {
      const owned = new Set(
        body.nfts.map((n: any) => Number(n?.serial_number)).filter((n: number) => Number.isInteger(n)),
      );
      const missing = allSerials.filter((s) => !owned.has(s));
      if (missing.length > 0) {
        return {
          error:
            `sender ${sender} does not own serial(s) ${missing.join(", ")} of ${tokenId} ` +
            `(mirror node) — an airdrop can only send what the sender holds`,
        };
      }
    } else {
      warnings.push(
        "could not verify NFT ownership on the mirror node — proceeding; the transaction will fail on submit if the sender lacks a serial",
      );
    }
  } else {
    const total = transfers.reduce((a, t) => a + BigInt(t.amount!), 0n);
    const { ok, body } = await fetchJson(
      fetchFn,
      `${MIRROR_BASE}/accounts/${sender}/tokens?token.id=${tokenId}`,
    );
    if (ok && body && Array.isArray(body.tokens) && body.tokens.length > 0) {
      const balance = BigInt(body.tokens[0]?.balance ?? 0);
      if (balance < total) {
        return {
          error:
            `sender ${sender} holds ${balance} of ${tokenId} but the airdrop needs ${total} ` +
            `(mirror node) — an airdrop can only send what the sender holds`,
        };
      }
    } else {
      warnings.push(
        "could not verify the token balance on the mirror node — proceeding; the transaction will fail on submit if the balance is insufficient",
      );
    }
  }

  // Build the UNSIGNED TokenAirdropTransaction. Debit sender, credit
  // each recipient; receivers without an association slot get a PENDING
  // airdrop automatically (HIP-904) — no pre-association needed.
  const tx = new TokenAirdropTransaction();
  const senderAcct = AccountId.fromString(sender);
  const tid = TokenId.fromString(tokenId);
  try {
    if (kind === "nft") {
      for (const t of transfers) {
        for (const serial of t.serial_numbers!) {
          tx.addNftTransfer(NftId.fromString(`${tokenId}@${serial}`), senderAcct, AccountId.fromString(t.recipient));
        }
      }
    } else {
      for (const t of transfers) {
        const amount = BigInt(t.amount!);
        tx.addTokenTransfer(tid, senderAcct, -amount);
        tx.addTokenTransfer(tid, AccountId.fromString(t.recipient), amount);
      }
    }
    tx.setTransactionId(TransactionId.generate(senderAcct));
    const client = Client.forMainnet(); // mainnet only — no testnet
    try {
      tx.freezeWith(client);
    } finally {
      client.close();
    }
  } catch (e) {
    return { error: `could not build the airdrop transaction: ${(e as Error).message}` };
  }

  return {
    sender_account_id: sender,
    token_id: tokenId,
    kind: kind!,
    transfers,
    unsigned_tx_base64: Buffer.from(tx.toBytes()).toString("base64"),
    warnings,
    instructions:
      "This transaction is UNSIGNED — the server never signed it and never will. " +
      "Decode unsigned_tx_base64, load it as a frozen TokenAirdropTransaction with the SENDER's Hedera key " +
      "(Transaction.fromBytes, then sign with the sender's key — do NOT change recipients or amounts), " +
      "and submit. YOU pay all network fees plus any custom fees, royalties, and association-rent the " +
      "airdrop incurs — the platform pays and takes nothing. Receivers WITHOUT an association slot get " +
      "a PENDING airdrop automatically (HIP-904): nothing fails, they claim it with a TokenClaimAirdrop " +
      "transaction (or you cancel unclaimed ones with TokenCancelAirdrop). Check what's pending with " +
      "check_pending_airdrops. Never put your private key in a tool argument or chat message.",
  };
}

export interface PendingAirdrop {
  token_id: string;
  serial_number: number | null;
  amount: string | null;
  sender_id: string;
  receiver_id: string;
}

/**
 * Read-only: list an account's pending HIP-904 airdrops from the mirror
 * node — what's waiting for the account to claim. Honest empty result
 * when there's nothing pending.
 */
export async function checkPendingAirdropsTool(
  args: { account_id: string },
  fetchFn: FetchFn = fetch,
): Promise<{ account_id: string; pending: PendingAirdrop[] } | { error: string }> {
  const accountId = (args.account_id ?? "").toString().trim();
  if (!ACCOUNT_RE.test(accountId)) {
    return { error: `account_id "${args.account_id}" is not a 0.0.x account id` };
  }
  const { ok, body } = await fetchJson(
    fetchFn,
    `${MIRROR_BASE}/accounts/${accountId}/airdrops/pending?limit=100`,
  );
  if (!ok || !body || !Array.isArray(body.airdrops)) {
    return { error: `could not read pending airdrops for ${accountId} — try again in a moment` };
  }
  return {
    account_id: accountId,
    pending: body.airdrops.map((a: any) => ({
      token_id: a?.token_id ?? "",
      serial_number:
        a?.serial_number !== undefined && a?.serial_number !== null ? Number(a.serial_number) : null,
      amount: a?.amount !== undefined && a?.amount !== null ? String(a.amount) : null,
      sender_id: a?.sender_id ?? "",
      receiver_id: a?.receiver_id ?? "",
    })),
  };
}
