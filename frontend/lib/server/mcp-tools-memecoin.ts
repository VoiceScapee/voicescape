/**
 * Voicescape MCP — meme-coin launch preparation (unsigned HTS fungible token create).
 *
 * `prepare_memecoin_launch` builds a FROZEN, UNSIGNED TokenCreateTransaction
 * for a fungible HTS token and returns it as base64. The BUYER signs and
 * submits in their own wallet (HashPack/Blade/WalletConnect) and pays the
 * network fee (~$1, approximate) from their own account.
 *
 * Design constraints (deliberate):
 * - The server NEVER signs and NEVER holds keys. The agent offering this
 *   service NEVER holds the buyer's token keys either — treasury, admin key,
 *   supply key, and auto-renew account are ALL the buyer's. An agent holding
 *   a supply key is a custody trap; this tool makes that structurally
 *   impossible by binding every key role to the buyer's key.
 * - Neutral tooling only. This is a token-minting utility, not investment
 *   advice, not promotion. Copy rules are enforced by test (see HYPE_WORDS).
 * - No new dependencies: @hiero-ledger/sdk TokenCreateTransaction, frozen
 *   unsigned via the same pattern as buildAttestationTx in mcp-review.ts.
 */

import {
  AccountId,
  PublicKey,
  TokenCreateTransaction,
  Transaction,
  TransactionId,
} from "@hiero-ledger/sdk";

export interface MemecoinLaunchInput {
  token_name: string;
  token_symbol: string;
  /** Integer 0-8. */
  decimals: number;
  /** Whole-token amount as an integer string, e.g. "1000000". Never negative. */
  initial_supply: string;
  /** Buyer's Hedera account, e.g. "0.0.12345". Becomes treasury + auto-renew account. */
  buyer_account_id: string;
  /** Buyer's public key (hex, as exported by their wallet). Becomes admin + supply key. */
  buyer_public_key: string;
  /** Optional token memo, max 100 bytes. */
  token_memo?: string;
}

export interface PreparedMemecoinLaunch {
  unsigned_tx_base64: string;
  token: {
    name: string;
    symbol: string;
    decimals: number;
    initial_supply_display: string;
    initial_supply_base_units: string;
  };
  treasury_account_id: string;
  key_roles: string;
  buyer_checklist: string[];
  fee_note: string;
  positioning: string;
}

/** Words/phrases that must never appear in this tool's copy. Enforced by test. */
export const HYPE_WORDS = [
  "to the moon",
  "moon",
  "pump",
  "lambo",
  "100x",
  "1000x",
  "get in early",
  "guaranteed",
  "can't lose",
  "financial advice",
];

/** Max base-unit supply: int64 max (Hedera hard limit). */
const MAX_BASE_UNITS = BigInt("9223372036854775807");

const ACCOUNT_RE = /^0\.0\.[1-9]\d*$/;

function fail(msg: string): { error: string } {
  return { error: msg };
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function prepareMemecoinLaunch(
  input: MemecoinLaunchInput,
): { ok: PreparedMemecoinLaunch } | { error: string } {
  const name = (input.token_name ?? "").trim();
  const symbol = (input.token_symbol ?? "").trim().toUpperCase();
  const memo = (input.token_memo ?? "").trim();

  if (!name || byteLen(name) > 100) {
    return fail("token_name must be 1-100 bytes.");
  }
  if (!symbol || byteLen(symbol) > 100) {
    return fail("token_symbol must be 1-100 bytes.");
  }
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 8) {
    return fail("decimals must be an integer 0-8.");
  }
  if (memo && byteLen(memo) > 100) {
    return fail("token_memo must be at most 100 bytes.");
  }
  if (typeof input.initial_supply !== "string" || !/^\d+$/.test(input.initial_supply)) {
    return fail("initial_supply must be a non-negative integer string (whole tokens).");
  }
  let baseUnits: bigint;
  try {
    baseUnits = BigInt(input.initial_supply) * 10n ** BigInt(input.decimals);
  } catch {
    return fail("initial_supply is not a valid integer.");
  }
  if (baseUnits > MAX_BASE_UNITS) {
    return fail(
      "initial_supply x 10^decimals exceeds the Hedera int64 maximum — lower the supply or decimals.",
    );
  }

  const buyerAccountId = (input.buyer_account_id ?? "").trim();
  if (!ACCOUNT_RE.test(buyerAccountId)) {
    return fail("buyer_account_id must be a valid Hedera account id (0.0.x, x > 0).");
  }

  let buyerKey: PublicKey;
  try {
    buyerKey = PublicKey.fromString((input.buyer_public_key ?? "").trim());
  } catch {
    return fail(
      "buyer_public_key is not a parseable public key. Export the PUBLIC key (hex) from the buyer's wallet — never a private key or seed phrase.",
    );
  }

  let unsignedB64: string;
  try {
    const tx = new TokenCreateTransaction()
      .setTokenName(name)
      .setTokenSymbol(symbol)
      .setDecimals(input.decimals)
      .setInitialSupply(baseUnits)
      .setTreasuryAccountId(AccountId.fromString(buyerAccountId))
      .setAdminKey(buyerKey)
      .setSupplyKey(buyerKey)
      .setAutoRenewAccountId(AccountId.fromString(buyerAccountId))
      // Payer is left unset — the signing buyer sets their own account.
      .setTransactionId(TransactionId.generate(AccountId.fromString("0.0.0")))
      .setNodeAccountIds([AccountId.fromString("0.0.3")]);
    if (memo) tx.setTokenMemo(memo);
    tx.freeze();
    unsignedB64 = Buffer.from(tx.toBytes()).toString("base64");
  } catch (e) {
    return fail(`failed to build the unsigned token create: ${(e as Error).message}`);
  }

  // Sanity: the bytes must re-parse as a token create carrying our fields.
  // (Checked by field, not constructor name — bundlers may minify class names.)
  try {
    const back = Transaction.fromBytes(Buffer.from(unsignedB64, "base64")) as unknown as {
      tokenName?: string;
      tokenSymbol?: string;
    };
    if (back?.tokenName !== name || back?.tokenSymbol !== symbol) {
      return fail("internal error: built bytes did not re-parse with the expected token fields.");
    }
  } catch {
    return fail("internal error: built bytes failed to re-parse.");
  }

  return {
    ok: {
      unsigned_tx_base64: unsignedB64,
      token: {
        name,
        symbol,
        decimals: input.decimals,
        initial_supply_display: input.initial_supply,
        initial_supply_base_units: baseUnits.toString(),
      },
      treasury_account_id: buyerAccountId,
      key_roles:
        "Treasury, admin key, supply key, and auto-renew account are ALL the buyer's. " +
        "The server never saw a private key, and the agent offering this service never holds one either. " +
        "Whoever holds the buyer's wallet seed controls this token — there is no recovery path.",
      buyer_checklist: [
        "You (the buyer) hold EVERY key for this token from birth. Back up your wallet seed phrase — losing it means losing control of the token permanently.",
        "Decode the bytes (base64 -> TokenCreateTransaction), verify the name/symbol/supply/treasury match what you ordered, then sign and submit in YOUR OWN wallet (HashPack/Blade/WalletConnect).",
        "The network fee (~$1, approximate — verify against the live Hedera fee schedule) is paid from your wallet on submit. Any service fee the agent charges settles separately through the Tips contract 98/2.",
        "Anyone who should receive this token must associate it in their wallet first (in HashPack: open the token, tap associate).",
        "After your create lands, verify it on HashScan from your account page and keep the token id.",
      ],
      fee_note:
        "Network fee is approximate (~$1 for TokenCreate) and paid by the buyer; confirm against the live Hedera fee schedule before quoting. Voicescape takes no cut of token creation — the platform only earns its 2% when a separate Tips-contract payment settles.",
      positioning:
        "Neutral token-minting utility. Minting a token is not investment advice and says nothing about the token's value.",
    },
  };
}

/** The MCP-facing description. Kept as a const so tests can enforce the no-hype rule. */
export const PREPARE_MEMECOIN_LAUNCH_DESCRIPTION =
  "Prepare an HTS fungible-token creation as UNSIGNED bytes for the BUYER to sign — the meme-coin launch service. " +
  "You (the agent) offer this to a buyer: they give you the token name, symbol, decimals (0-8), whole-token initial supply, " +
  "their Hedera account id, and their PUBLIC key. You call this tool; it returns base64 unsigned TokenCreateTransaction bytes " +
  "plus a buyer checklist. The buyer verifies the bytes, signs in their OWN wallet, submits, and pays the ~$1 network fee themselves " +
  "(approximate — verify against the live Hedera fee schedule). " +
  "KEY RULE: treasury, admin key, supply key, and auto-renew are ALL the buyer's — you never hold any token key, and neither does this server. " +
  "Never ask for or handle a private key or seed phrase. " +
  "This is neutral minting tooling, not investment advice; make no claims about value, price, or returns.";
