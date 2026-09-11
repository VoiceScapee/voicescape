/**
 * TxSender — one interface for Voicescape contract calls, implemented per
 * wallet family:
 *
 *  - EVM (MetaMask on Hedera): ethers v6 against the chain's JSON-RPC.
 *    Reads go through a public JsonRpcProvider; writes use the wallet signer.
 *  - Hedera (HashPack / Blade / WalletConnect via HashConnect): the same
 *    Solidity contracts are called through @hashgraph/sdk
 *    ContractExecuteTransaction / ContractCallQuery, signed in the wallet
 *    via hashconnect.sendTransaction(). Contract addresses are the EVM
 *    addresses from the Hardhat deploy, converted with
 *    ContractId.fromEvmAddress(0, 0, address).
 *
 * Read-only senders (no wallet) support viewResolve(); the send* methods
 * throw a "connect a wallet" error.
 */
import { ethers } from "ethers";
import {
  AccountId,
  Client,
  ContractCallQuery,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
} from "@hashgraph/sdk";
import type { DAppConnector } from "@hashgraph/hedera-wallet-connect";
import type { ChainConfig } from "./chains";

/* ------------------------------------------------------------------ */
/* ABIs (human-readable; verified against                            */
/* contracts/artifacts/.../VoicescapeRegistry.json and                */
/* VoicescapeTips.json — function names and signatures match exactly)  */
/* ------------------------------------------------------------------ */

export const REGISTRY_ABI = [
  // Phase B: ownerType 0 = HUMAN, 1 = AGENT. Agents MUST supply operator + purpose
  // (the contract reverts otherwise); humans pass the zero address + "".
  "function registerPage(string username, string ipfsHash, uint8 ownerType, address operator, string purpose)",
  "function updatePage(string username, string ipfsHash)",
  "function resolvePage(string username) view returns (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)",
  "function usernameExists(string username) view returns (bool)",
] as const;

export const TIPS_ABI = [
  "function tipPage(string username) payable",
  "function buyListing(address seller, string listingRef) payable",
  "function treasury() view returns (address)",
] as const;

export interface ResolveResult {
  owner: string;
  ipfsHash: string;
  /** 0 = human, 1 = agent. Older deployments may return 0 for every page. */
  ownerType: 0 | 1;
  /** Agent operator wallet (zero address for humans). */
  operator: string;
  /** Agent purpose disclosure (empty for humans). */
  purpose: string;
}

/** Zero address — what human pages register as their operator. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface TxSender {
  /** "evm" for MetaMask, "hedera" for Hedera wallets. */
  readonly kind: "evm" | "hedera";
  /** 0x… address or 0.0.x account id, depending on kind. */
  readonly account: string;
  /** Resolve a username. Returns null when the name is not registered. */
  viewResolve(registryAddress: string, username: string): Promise<ResolveResult | null>;
  /**
   * Register a new page. Resolves to the transaction hash / id.
   * ownerType: 0 = human, 1 = agent. Agents MUST pass a real operator
   * address + non-empty purpose; humans pass ZERO_ADDRESS + "".
   */
  sendRegister(
    registryAddress: string,
    username: string,
    ipfsHash: string,
    ownerType: 0 | 1,
    operator: string,
    purpose: string,
  ): Promise<string>;
  /** Update a page's IPFS hash. Resolves to the transaction hash / id. */
  sendUpdate(registryAddress: string, username: string, ipfsHash: string): Promise<string>;
  /** Tip a page (native currency). valueWei uses 18 decimals on every chain. */
  sendTip(tipsAddress: string, username: string, valueWei: bigint): Promise<string>;
  /**
   * Buy a marketplace listing (native currency). The Tips contract splits
   * 98% to the seller and 2% to the treasury ATOMICALLY in one transaction —
   * it never holds buyer funds (no escrow). Delivery is off-chain.
   */
  sendBuy(tipsAddress: string, seller: string, listingRef: string, valueWei: bigint): Promise<string>;
}

/* ------------------------------------------------------------------ */
/* EVM implementation (ethers v6)                                       */
/* ------------------------------------------------------------------ */

export function createEvmTxSender(
  provider: ethers.Provider,
  signer: ethers.Signer | null,
  account: string,
): TxSender {
  function requireSigner(): ethers.Signer {
    if (!signer) throw new Error("Connect a wallet to send transactions.");
    return signer;
  }

  return {
    kind: "evm",
    account,
    async viewResolve(registryAddress, username) {
      const contract = new ethers.Contract(registryAddress, REGISTRY_ABI, provider);
      try {
        const [owner, ipfsHash, ownerType, operator, purpose]: [string, string, bigint, string, string] =
          await contract.resolvePage(username);
        return { owner, ipfsHash, ownerType: Number(ownerType) === 1 ? 1 : 0, operator, purpose };
      } catch {
        // resolvePage reverts with UsernameInvalid when the name is unknown.
        return null;
      }
    },
    async sendRegister(registryAddress, username, ipfsHash, ownerType, operator, purpose) {
      const contract = new ethers.Contract(registryAddress, REGISTRY_ABI, requireSigner());
      const tx = await contract.registerPage(username, ipfsHash, ownerType, operator, purpose);
      const receipt = await tx.wait();
      return receipt.hash;
    },
    async sendUpdate(registryAddress, username, ipfsHash) {
      const contract = new ethers.Contract(registryAddress, REGISTRY_ABI, requireSigner());
      const tx = await contract.updatePage(username, ipfsHash);
      const receipt = await tx.wait();
      return receipt.hash;
    },
    async sendTip(tipsAddress, username, valueWei) {
      if (valueWei <= 0n) throw new Error("Tip amount must be greater than zero.");
      const contract = new ethers.Contract(tipsAddress, TIPS_ABI, requireSigner());
      const tx = await contract.tipPage(username, { value: valueWei });
      const receipt = await tx.wait();
      return receipt.hash;
    },
    async sendBuy(tipsAddress, seller, listingRef, valueWei) {
      if (valueWei <= 0n) throw new Error("Purchase amount must be greater than zero.");
      if (!/^0x[0-9a-fA-F]{40}$/.test(seller)) throw new Error("Seller address is invalid.");
      const contract = new ethers.Contract(tipsAddress, TIPS_ABI, requireSigner());
      const tx = await contract.buyListing(seller, listingRef, { value: valueWei });
      const receipt = await tx.wait();
      return receipt.hash;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Hedera implementation (@hashgraph/sdk + HashConnect)                 */
/* ------------------------------------------------------------------ */

const HEDERA_WRITE_GAS = 600_000;
const HEDERA_QUERY_GAS = 200_000;
/** On the Hedera EVM, 1 tinybar = 10^10 wei (1 HBAR = 10^8 tinybar = 10^18 wei). */
const WEI_PER_TINYBAR = 10_000_000_000n;

function hederaContractId(evmAddress: string): ContractId {
  if (!/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) {
    throw new Error(
      `Invalid contract address "${evmAddress}". Deploy the contracts first and set the address in env.`,
    );
  }
  return ContractId.fromEvmAddress(0, 0, evmAddress);
}

/**
 * @param dAppConnector Live DAppConnector instance, or null for a read-only sender.
 * @param accountIdStr Paired Hedera account id ("0.0.x"), or null when read-only.
 */
export function createHederaTxSender(
  dAppConnector: DAppConnector | null,
  accountIdStr: string | null,
  chain: ChainConfig,
): TxSender {
  const isMainnet = chain.key === "hedera-mainnet";
  // Public client — no operator needed for ContractCallQuery.
  const queryClient = isMainnet ? Client.forMainnet() : Client.forTestnet();

  function requireWallet(): { dAppConnector: DAppConnector; accountId: AccountId } {
    if (!dAppConnector || !accountIdStr) throw new Error("Connect a Hedera wallet to send transactions.");
    return { dAppConnector, accountId: AccountId.fromString(accountIdStr) };
  }

  async function executeWrite(
    evmAddress: string,
    fn: string,
    params: ContractFunctionParameters,
    valueWei?: bigint,
  ): Promise<string> {
    const { dAppConnector: liveConnector, accountId } = requireWallet();
    const tx = new ContractExecuteTransaction()
      .setContractId(hederaContractId(evmAddress))
      .setGas(HEDERA_WRITE_GAS)
      .setFunction(fn, params);
    if (valueWei !== undefined) {
      if (valueWei <= 0n) throw new Error("Payment amount must be greater than zero.");
      const tinybars = valueWei / WEI_PER_TINYBAR;
      if (tinybars === 0n) {
        throw new Error("Payment amount is below 1 tinybar — increase the amount.");
      }
      tx.setPayableAmount(Hbar.fromTinybars(tinybars.toString()));
    }
    // freezeWithSigner fills in transaction id + node account ids via the wallet.
    // DAppConnector.getSigner returns a DAppSigner (hiero-sdk based); cast to
    // the hashgraph-sdk Signer interface — the two SDKs are runtime-compatible.
    const signer = (liveConnector.getSigner as unknown as (id: unknown) => Parameters<typeof tx.freezeWithSigner>[0])(accountId);
    await tx.freezeWithSigner(signer);
    const txId = tx.transactionId?.toString() ?? "";
    // DAppConnector signs AND executes via the wallet (HIP-820).
    const { transactionToBase64String } = await import("@hashgraph/hedera-wallet-connect");
    const network = chain.key === "hedera-mainnet" ? "mainnet" : "testnet";
    await (liveConnector.signAndExecuteTransaction as unknown as (params: object) => Promise<unknown>)({
      signerAccountId: `hedera:${network}:${accountId.toString()}`,
      transactionList: transactionToBase64String(tx as unknown as Parameters<typeof transactionToBase64String>[0]),
    });
    // HashScan deep link format: <network>/transaction/<txId>
    return txId;
  }

  return {
    kind: "hedera",
    account: accountIdStr ?? "",
    async viewResolve(registryAddress, username) {
      try {
        const result = await new ContractCallQuery()
          .setContractId(hederaContractId(registryAddress))
          .setGas(HEDERA_QUERY_GAS)
          .setFunction("resolvePage", new ContractFunctionParameters().addString(username))
          .execute(queryClient);
        return {
          owner: result.getAddress(0),
          ipfsHash: result.getString(1),
          ownerType: Number(result.getUint8(2)) === 1 ? (1 as const) : (0 as const),
          operator: result.getAddress(3),
          purpose: result.getString(4),
        };
      } catch {
        // resolvePage reverts with UsernameInvalid when the name is unknown.
        return null;
      }
    },
    async sendRegister(registryAddress, username, ipfsHash, ownerType, operator, purpose) {
      return executeWrite(
        registryAddress,
        "registerPage",
        new ContractFunctionParameters()
          .addString(username)
          .addString(ipfsHash)
          .addUint8(ownerType)
          .addAddress(operator)
          .addString(purpose),
      );
    },
    async sendUpdate(registryAddress, username, ipfsHash) {
      return executeWrite(
        registryAddress,
        "updatePage",
        new ContractFunctionParameters().addString(username).addString(ipfsHash),
      );
    },
    async sendTip(tipsAddress, username, valueWei) {
      return executeWrite(
        tipsAddress,
        "tipPage",
        new ContractFunctionParameters().addString(username),
        valueWei,
      );
    },
    async sendBuy(tipsAddress, seller, listingRef, valueWei) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(seller)) {
        throw new Error("Seller address is invalid.");
      }
      return executeWrite(
        tipsAddress,
        "buyListing",
        new ContractFunctionParameters().addAddress(seller).addString(listingRef),
        valueWei,
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* Read-only factory (public page loads need no wallet)                 */
/* ------------------------------------------------------------------ */

export function createReadOnlySender(chain: ChainConfig): TxSender {
  if (chain.key === "hedera-testnet" || chain.key === "hedera-mainnet") {
    return createHederaTxSender(null, null, chain);
  }
  return createEvmTxSender(new ethers.JsonRpcProvider(chain.rpcUrl), null, "");
}
