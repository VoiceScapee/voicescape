/**
 * vault-tx — build the UNSIGNED Hedera transactions behind the Agent Vault.
 *
 * Mainnet only. These builders never sign and never touch private keys:
 * they freeze the transaction body so the human's wallet (DAppConnector /
 * HIP-820) can sign exactly one signature per action. The client submits
 * the base64 bytes through the existing submitPreparedTx pipeline.
 *
 * Three whitelisted actions, nothing else:
 * - create: AccountCreateTransaction with KeyList([human, agent], 1),
 *   setKeyWithoutAlias (the key WILL rotate — revocation, agent rotation —
 *   so no immutable EVM alias), initial balance = the vault funding.
 * - revoke: AccountUpdateTransaction setting the vault key to the human's
 *   key only. The human's single signature satisfies both the old
 *   threshold-1 key and the new-key role.
 * - sweep: TransferTransaction moving the vault's spendable HBAR back to
 *   the human's own account (destination is ALWAYS the human — no
 *   arbitrary recipient). Keeps a fee cushion so the transfer itself can
 *   pay for its signature.
 */

import {
  AccountCreateTransaction,
  AccountId,
  AccountUpdateTransaction,
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
  KeyList,
  PublicKey,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";

/** Mainnet Voicescape Registry — registerPage / updatePage. */
const REGISTRY_CONTRACT_ID = "0.0.10854058";
/** Conservative gas for Registry calls (register is the heavier call). */
const REGISTRY_CALL_GAS = 600_000;

export interface BuiltUnsignedTx {
  /** Base64 frozen unsigned transaction bytes (wallet signs these). */
  unsignedTxBytes: string;
  /** The tx's own id, "0.0.x@seconds.nanos" — for mirror confirmation. */
  transactionId: string;
  txType: string;
}

function freezeUnsigned(
  tx:
    | AccountCreateTransaction
    | AccountUpdateTransaction
    | TransferTransaction
    | ContractExecuteTransaction,
  payerAccountId: string,
): BuiltUnsignedTx {
  const client = Client.forMainnet();
  try {
    const payer = AccountId.fromString(payerAccountId);
    const txId = TransactionId.generate(payer);
    tx.setTransactionId(txId);
    // freezeWith signs nothing — it finalizes the body for the wallet.
    tx.freezeWith(client);
    const bytes = tx.toBytes();
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return {
      unsignedTxBytes: btoa(binary),
      transactionId: txId.toString(),
      txType: tx.constructor.name,
    };
  } finally {
    client.close();
  }
}

export interface VaultCreateInput {
  /** Validated human SDK PublicKey (from the mirror node). */
  humanKey: PublicKey;
  /** Validated agent SDK PublicKey (ED25519, from the package). */
  agentKey: PublicKey;
  /** Vault funding in HBAR (2–25, validated upstream). */
  budgetHbar: number;
  /** Agent username, for the account memo. */
  agentUsername: string;
  /** Payer = the human's account (pays fee + funding in one signature). */
  payerAccountId: string;
}

/**
 * Build the vault-creation transaction: a new account whose key is
 * KeyList([humanKey, agentKey]) with threshold 1 — either key alone can
 * act. setKeyWithoutAlias: the key will rotate later (revocation, agent
 * key rotation), and an EVM alias would make that immutable.
 */
export function buildVaultCreateTx(input: VaultCreateInput): BuiltUnsignedTx {
  if (!/^0\.0\.\d+$/.test(input.payerAccountId)) {
    throw new Error("buildVaultCreateTx: bad payer account id");
  }
  // Sanity only — the true live floor is enforced upstream (vault-costs).
  if (!Number.isFinite(input.budgetHbar) || input.budgetHbar < 0.1 || input.budgetHbar > 25) {
    throw new Error("buildVaultCreateTx: budget out of range");
  }
  const keyList = new KeyList([input.humanKey, input.agentKey], 1);
  const tx = new AccountCreateTransaction()
    .setKeyWithoutAlias(keyList)
    .setInitialBalance(new Hbar(input.budgetHbar))
    .setAccountMemo(`Voicescape agent vault: @${input.agentUsername}`.slice(0, 100))
    .setTransactionMemo(`Voicescape vault setup for @${input.agentUsername}`.slice(0, 100));
  return { ...freezeUnsigned(tx, input.payerAccountId), txType: "AccountCreateTransaction" };
}

export interface VaultRevokeInput {
  /** The vault account whose key is being reset. */
  vaultAccountId: string;
  /** Validated human SDK PublicKey — becomes the ONLY key. */
  humanKey: PublicKey;
  /** Payer = the human (their signature is the revocation). */
  payerAccountId: string;
}

/**
 * Build the revocation transaction: vault key → human-only. After this
 * lands, the agent's key is cryptographically dead — its next transaction
 * fails INVALID_SIGNATURE. One human signature, ~$0.05.
 */
export function buildVaultRevokeTx(input: VaultRevokeInput): BuiltUnsignedTx {
  if (!/^0\.0\.\d+$/.test(input.vaultAccountId)) {
    throw new Error("buildVaultRevokeTx: bad vault account id");
  }
  if (!/^0\.0\.\d+$/.test(input.payerAccountId)) {
    throw new Error("buildVaultRevokeTx: bad payer account id");
  }
  const tx = new AccountUpdateTransaction()
    .setAccountId(AccountId.fromString(input.vaultAccountId))
    // Note: AccountUpdateTransaction has no setKeyWithoutAlias — there is no
    // alias concept on update (alias is only assigned at creation), so
    // setKey is correct here. The create path uses setKeyWithoutAlias.
    .setKey(input.humanKey)
    .setTransactionMemo("Voicescape vault: revoke agent access".slice(0, 100));
  return { ...freezeUnsigned(tx, input.payerAccountId), txType: "AccountUpdateTransaction" };
}

export interface VaultSweepInput {
  /** The vault to drain. */
  vaultAccountId: string;
  /** Destination — ALWAYS the human's own account. No other recipient. */
  humanAccountId: string;
  /** Vault balance in tinybar (live, read just before building). */
  vaultBalanceTinybar: bigint;
  /** Payer = the vault itself (it pays its own transfer fee). */
  payerAccountId: string;
}

/** Fee cushion left behind so the sweep's own signature can be paid. */
export const SWEEP_FEE_CUSHION_TINYBAR = 60_000_000n; // 0.6 HBAR

/**
 * Build the fund-recovery sweep: vault → human, everything above the fee
 * cushion. The human runs this after revoking (or to empty a vault they
 * no longer want). Throws when the balance can't cover the cushion.
 */
export function buildVaultSweepTx(input: VaultSweepInput): BuiltUnsignedTx {
  if (!/^0\.0\.\d+$/.test(input.vaultAccountId)) {
    throw new Error("buildVaultSweepTx: bad vault account id");
  }
  if (!/^0\.0\.\d+$/.test(input.humanAccountId)) {
    throw new Error("buildVaultSweepTx: bad human account id");
  }
  if (input.payerAccountId !== input.vaultAccountId) {
    throw new Error("buildVaultSweepTx: the vault must pay for its own sweep");
  }
  if (input.vaultBalanceTinybar <= SWEEP_FEE_CUSHION_TINYBAR) {
    throw new Error(
      "buildVaultSweepTx: balance too low — not enough left to cover the transfer fee",
    );
  }
  const amount = input.vaultBalanceTinybar - SWEEP_FEE_CUSHION_TINYBAR;
  // fromTinybars takes string | number | Long — bigint goes via string.
  const amountHbar = Hbar.fromTinybars(amount.toString());
  const tx = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(input.vaultAccountId), amountHbar.negated())
    .addHbarTransfer(AccountId.fromString(input.humanAccountId), amountHbar)
    .setTransactionMemo("Voicescape vault: return funds to owner".slice(0, 100));
  return { ...freezeUnsigned(tx, input.payerAccountId), txType: "TransferTransaction" };
}

/* ------------------------------------------------------------------ */
/* Vault-owned page actions (the agent signs these itself)              */
/* ------------------------------------------------------------------ */

export interface VaultRegisterPageInput {
  /** The vault account — payer AND page owner (msg.sender on-chain). */
  vaultAccountId: string;
  /** 3-24 chars, lowercase; the server verifies it is still free. */
  username: string;
  /** Pinned starter-page CID. */
  ipfsCid: string;
  /** On-chain purpose disclosure (1-500 chars). */
  purpose: string;
}

export interface VaultUpdatePageInput {
  /** The vault account — payer AND current page owner. */
  vaultAccountId: string;
  /** Must already be owned by the vault on-chain. */
  username: string;
  /** Pinned updated-page CID. */
  ipfsCid: string;
}

const USERNAME_RE = /^[a-z0-9_-]{3,24}$/;
/** CIDs the dapp pins (v0 Qm… / v1 bafy…). Length-checked, not exhaustive. */
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{55,})$/;

function checkPageInput(username: string, ipfsCid: string, what: string): void {
  const name = username.trim().toLowerCase();
  if (!USERNAME_RE.test(name)) {
    throw new Error(`${what}: username must be 3-24 lowercase letters, numbers, _ or -`);
  }
  if (!CID_RE.test(ipfsCid.trim())) {
    throw new Error(`${what}: ipfs_cid doesn't look like a pinned IPFS CID`);
  }
}

/**
 * Build the UNSIGNED registerPage call with the VAULT as payer/owner.
 * The agent signs this with its own vault key in its own environment —
 * the server never sees the agent's private key. ownerType=1 (agent);
 * operator is the vault's long-zero EVM address.
 */
export function buildVaultRegisterPageTx(
  input: VaultRegisterPageInput,
): BuiltUnsignedTx {
  if (!/^0\.0\.\d+$/.test(input.vaultAccountId)) {
    throw new Error("buildVaultRegisterPageTx: bad vault account id");
  }
  checkPageInput(input.username, input.ipfsCid, "buildVaultRegisterPageTx");
  const purpose = (input.purpose ?? "").trim();
  if (!purpose || purpose.length > 500) {
    throw new Error("buildVaultRegisterPageTx: purpose is required (1-500 chars)");
  }
  const name = input.username.trim().toLowerCase();
  // Long-zero EVM address of the vault — the Registry stores owner as
  // msg.sender, which will be the vault when the agent submits.
  const operator = `0x${AccountId.fromString(input.vaultAccountId).toEvmAddress()}`;
  const params = new ContractFunctionParameters()
    .addString(name)
    .addString(input.ipfsCid.trim())
    .addUint8(1)
    .addAddress(operator)
    .addString(purpose);
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(REGISTRY_CONTRACT_ID))
    .setGas(REGISTRY_CALL_GAS)
    .setFunction("registerPage", params)
    .setTransactionMemo(`Voicescape vault: register @${name}`.slice(0, 100));
  return { ...freezeUnsigned(tx, input.vaultAccountId), txType: "ContractExecuteTransaction" };
}

/**
 * Build the UNSIGNED updatePage call with the VAULT as payer/owner.
 * Only valid when the vault already owns the username on-chain (the
 * caller verifies that; a human's own account calling updatePage would
 * revert NotPageOwner — the vault must be the signer).
 */
export function buildVaultUpdatePageTx(input: VaultUpdatePageInput): BuiltUnsignedTx {
  if (!/^0\.0\.\d+$/.test(input.vaultAccountId)) {
    throw new Error("buildVaultUpdatePageTx: bad vault account id");
  }
  checkPageInput(input.username, input.ipfsCid, "buildVaultUpdatePageTx");
  const name = input.username.trim().toLowerCase();
  const params = new ContractFunctionParameters()
    .addString(name)
    .addString(input.ipfsCid.trim());
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(REGISTRY_CONTRACT_ID))
    .setGas(REGISTRY_CALL_GAS)
    .setFunction("updatePage", params)
    .setTransactionMemo(`Voicescape vault: update @${name}`.slice(0, 100));
  return { ...freezeUnsigned(tx, input.vaultAccountId), txType: "ContractExecuteTransaction" };
}
