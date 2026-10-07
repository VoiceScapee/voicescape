/**
 * update-page-tx — build the UNSIGNED updatePage transaction behind the
 * keyless-agent operation path.
 *
 * Mainnet only. This builder never signs and never touches private keys:
 * it freezes the transaction body so the human's wallet (DAppConnector /
 * HIP-820) can sign exactly one signature at approve time. The client
 * submits the base64 bytes through the existing submitPreparedTx pipeline.
 *
 * Only one whitelisted action: updatePage(username, ipfsHash) on the
 * Voicescape Registry — the page's content pointer. The contract itself
 * enforces owner-only; the caller verifies on-chain ownership before
 * building.
 */
import {
  AccountId,
  Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  TransactionId,
} from "@hiero-ledger/sdk";

/** Mainnet Voicescape Registry. */
const REGISTRY_CONTRACT_ID = "0.0.10854058";
/** Conservative gas for Registry calls. */
const REGISTRY_CALL_GAS = 600_000;

export interface BuiltUpdatePageTx {
  /** Base64 frozen unsigned transaction bytes (the human's wallet signs these). */
  unsignedTxBytes: string;
  /** The tx's own id, "0.0.x@seconds.nanos" — for mirror confirmation. */
  transactionId: string;
  txType: "ContractExecuteTransaction";
}

export interface BuildUpdatePageTxInput {
  /** The page owner's account — payer and required signer. */
  ownerAccountId: string;
  /** Normalized lowercase username. */
  username: string;
  /** IPFS CID of the newly pinned page content. */
  ipfsCid: string;
}

/**
 * Build the UNSIGNED updatePage(username, ipfsCid) call with the owner as
 * payer. Throws on invalid input. Never signs.
 */
export function buildOwnerUpdatePageTx(input: BuildUpdatePageTxInput): BuiltUpdatePageTx {
  const owner = (input.ownerAccountId ?? "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(owner)) {
    throw new Error("buildOwnerUpdatePageTx: bad owner account id");
  }
  const username = (input.username ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
    throw new Error("buildOwnerUpdatePageTx: bad username");
  }
  const cid = (input.ipfsCid ?? "").trim();
  if (!cid || cid.length > 128) {
    throw new Error("buildOwnerUpdatePageTx: bad ipfs cid");
  }

  const client = Client.forMainnet();
  try {
    const payer = AccountId.fromString(owner);
    const txId = TransactionId.generate(payer);
    const params = new ContractFunctionParameters().addString(username).addString(cid);
    const tx = new ContractExecuteTransaction()
      .setContractId(ContractId.fromString(REGISTRY_CONTRACT_ID))
      .setGas(REGISTRY_CALL_GAS)
      .setFunction("updatePage", params)
      .setTransactionId(txId)
      .setTransactionMemo(`Voicescape: update @${username}`.slice(0, 100));
    // freezeWith signs nothing — it finalizes the body for the wallet.
    tx.freezeWith(client);
    const bytes = tx.toBytes();
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return {
      unsignedTxBytes: btoa(binary),
      transactionId: txId.toString(),
      txType: "ContractExecuteTransaction",
    };
  } finally {
    client.close();
  }
}
