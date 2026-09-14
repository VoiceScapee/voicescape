/**
 * TxSender — one interface for Voicescape contract calls, implemented per
 * wallet family:
 *
 *  - Hedera (HashPack / Blade / WalletConnect via DAppConnector): the same
 *    Solidity contracts are called through @hiero-ledger/sdk
 *    ContractExecuteTransaction / ContractCallQuery, signed in the wallet
 *    via HIP-820. Contract addresses are the EVM addresses from the Hardhat
 *    deploy, converted with ContractId.fromEvmAddress(0, 0, address).
 *
 * Read-only senders (no wallet) support viewResolve() via the official
 * Hedera mirror-node REST endpoint (POST /api/v1/contracts/call) —
 * again with ethers used only to encode/decode the calldata.
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
  TransactionId,
} from "@hiero-ledger/sdk";
import type { DAppConnector } from "@hashgraph/hedera-wallet-connect";
import type { ChainConfig } from "./chains";
import { toMirrorTxId } from "./tx-confirm";

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

/**
 * Thrown when the wallet goes silent after the user approved (the 90s
 * timeout). Carries the transaction id we generated ourselves, so the UI
 * can switch to a live on-chain "confirming…" state instead of an error —
 * the transaction may well have executed.
 */
export class WalletTimeoutError extends Error {
  readonly txId: string;
  constructor(txId: string) {
    super(
      "Your wallet didn't respond in time. The transaction may still have gone through — " +
        "we're checking on-chain now instead of guessing.",
    );
    this.name = "WalletTimeoutError";
    this.txId = txId;
  }
}

export interface TxSender {
  /** "hedera" for Hedera wallets (HashPack / Blade / WalletConnect). */
  readonly kind: "hedera";
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
/* Shared ABI interfaces (ethers encode/decode only — never chain I/O)   */
/* ------------------------------------------------------------------ */

const REGISTRY_IFACE = new ethers.Interface(REGISTRY_ABI);
const TIPS_IFACE = new ethers.Interface(TIPS_ABI);

/* ------------------------------------------------------------------ */
/* Hedera implementation (@hiero-ledger/sdk + HashConnect)                 */
/* ------------------------------------------------------------------ */

const HEDERA_WRITE_GAS = 600_000;
const HEDERA_QUERY_GAS = 200_000;
/** On the Hedera EVM, 1 tinybar = 10^10 wei (1 HBAR = 10^8 tinybar = 10^18 wei). */
const WEI_PER_TINYBAR = 10_000_000_000n;

/** Exported for tests — converts an EVM address to a Hedera ContractId. */
export function hederaContractId(evmAddress: string): ContractId {
  if (!/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) {
    throw new Error(
      `Invalid contract address "${evmAddress}". Deploy the contracts first and set the address in env.`,
    );
  }
  // Never build a transaction against the zero address — that shows up as
  // "Contract ID: 0.0.0" in HashPack and burns the user's gas on a no-op.
  // (This happened in production when NEXT_PUBLIC_TIPS_ADDRESS was left as
  // the 0x000...000 placeholder from .env.example.)
  if (/^0x0{40}$/i.test(evmAddress)) {
    throw new Error(
      `Contract address is the zero address (0x000...000) — a placeholder, not a deployed contract. ` +
      `Set the real EVM address in env. Refusing to build a transaction to 0.0.0.`,
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
  // Public client — no operator needed. Used for ContractCallQuery and for
  // freezing write transactions (fills in node account ids) before the
  // wallet signs them via HIP-820.
  const networkClient = isMainnet ? Client.forMainnet() : Client.forTestnet();

  function requireWallet(): { dAppConnector: DAppConnector; accountId: AccountId } {
    if (!dAppConnector || !accountIdStr) throw new Error("Connect a Hedera wallet to send transactions.");
    return { dAppConnector, accountId: AccountId.fromString(accountIdStr) };
  }

  /**
   * Check whether a transaction ID actually executed on-chain via the
   * mirror node. Used as a recovery path when the wallet goes silent
   * after the user approves — we generated the txId ourselves, so we can
   * look it up directly.
   * Returns "success" | "failed" | "unknown" (not visible yet).
   */
  async function checkTxLanded(txId: string): Promise<"success" | "failed" | "unknown"> {
    try {
      // txId is the SDK @ form; the mirror only answers the dash form.
      const res = await fetch(
        `https://mainnet.mirrornode.hedera.com/api/v1/contracts/results/${encodeURIComponent(toMirrorTxId(txId))}`,
      );
      if (!res.ok) return "unknown";
      const data = (await res.json()) as { status?: string; results?: Array<{ status?: string }> };
      const status = data.results?.[0]?.status ?? data.status;
      if (status === "0x1") return "success";
      if (status && status !== "0x1") return "failed";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * Check whether the WalletConnect session is still alive before asking
   * the wallet to sign. Stale sessions (HashPack #291) silently swallow
   * signing requests — no prompt appears, no error fires, and the app
   * hangs until the 90s timeout. Detecting the dead session up front lets
   * us fail fast with a "reconnect" message instead.
   *
   * Fail-open: if the session state can't be determined (e.g. iframe flow
   * internals), proceed as before rather than blocking a working flow.
   */
  function isSessionAlive(): boolean {
    try {
      const client = (
        dAppConnector as unknown as {
          walletConnectClient?: { session?: { getAll?: () => unknown[] } };
        }
      ).walletConnectClient;
      const sessions = client?.session?.getAll?.();
      // getAll() returning undefined = can't determine; fail open.
      if (sessions === undefined) return true;
      return sessions.length > 0;
    } catch {
      return true;
    }
  }

  async function executeWrite(
    evmAddress: string,
    fn: string,
    params: ContractFunctionParameters,
    valueWei?: bigint,
  ): Promise<string> {
    const { dAppConnector: liveConnector, accountId } = requireWallet();
    // Fail fast on a dead session — otherwise the wallet prompt never
    // appears and the user stares at "Publishing…" for 90 seconds.
    if (!isSessionAlive()) {
      throw new Error(
        "Wallet session expired — disconnect and reconnect your wallet, then try again.",
      );
    }
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
    // Freeze the tx body so the wallet can sign it (HIP-820). Set the tx id
    // from the wallet account and freeze with the public network client,
    // which fills in the node account ids. HashPack signs via
    // signAndExecuteTransaction.
    // NOTE: executeWithSigner() is broken in the current SDK (BUG:
    // Query.fromBytes() not implemented for getByKey), so we use the
    // lower-level signAndExecuteTransaction with manual serialization.
    tx.setTransactionId(TransactionId.generate(accountId));
    tx.freezeWith(networkClient);
    const txId = tx.transactionId?.toString() ?? "";
    // DAppConnector signs AND executes via the wallet (HIP-820).
    // The transactionList param is a base64-encoded single Transaction
    // (the name is misleading — the official DAppSigner uses
    // transactionToBase64String(transaction) for this param).
    const network = chain.key === "hedera-mainnet" ? "mainnet" : "testnet";
    const txBase64 = Buffer.from(tx.toBytes()).toString("base64");
    // The wallet response sometimes never arrives even though the user
    // approved in HashPack and the transaction executed on-chain. Without a
    // timeout the UI hangs on "Tipping…" forever. Race the wallet call
    // against a timeout, then check the mirror node for our txId — we
    // generated it ourselves, so we can verify whether it actually landed.
    const WALLET_TIMEOUT_MS = 90_000;
    let walletResponded = false;
    try {
      await Promise.race([
        (async () => {
          await (liveConnector.signAndExecuteTransaction as unknown as (params: object) => Promise<unknown>)({
            signerAccountId: `hedera:${network}:${accountId.toString()}`,
            transactionList: txBase64,
          });
          walletResponded = true;
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("WALLET_TIMEOUT")), WALLET_TIMEOUT_MS),
        ),
      ]);
    } catch (e) {
      if (e instanceof Error && e.message === "WALLET_TIMEOUT" && !walletResponded) {
        // Wallet went silent — check whether the transaction actually
        // executed on-chain before giving up.
        const landed = await checkTxLanded(txId);
        if (landed === "success") return txId;
        if (landed === "failed") {
          throw new Error("The transaction failed on-chain. No payment was sent.");
        }
        // Unknown: not visible on the mirror node yet. The user may have
        // approved in their wallet — never claim failure. Throw the tx id
        // along so the UI can confirm on-chain reactively instead of
        // showing a dead-end error.
        throw new WalletTimeoutError(txId);
      }
      throw e;
    }
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
          .execute(networkClient);
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

/**
 * Official Hedera mirror-node REST base per chain. Used for read-only
 * contract calls — no JSON-RPC provider, no ethers connectivity.
 */
function mirrorNodeBase(chain: ChainConfig): string {
  return chain.key === "hedera-testnet"
    ? "https://testnet.mirrornode.hedera.com"
    : "https://mainnet.mirrornode.hedera.com";
}

/**
 * eth_call equivalent against the official Hedera mirror node
 * (POST /api/v1/contracts/call). Returns the raw result calldata.
 * Exported for tests.
 */
export async function mirrorContractCall(
  chain: ChainConfig,
  to: string,
  data: string,
): Promise<string> {
  // Mobile connections can stall mid-request; without a timeout the UI
  // hangs on "Waiting on your wallet…" forever (seen in production
  // 2026-09-13). Fail fast with an actionable message instead.
  const MIRROR_TIMEOUT_MS = 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MIRROR_TIMEOUT_MS);
  try {
    const res = await fetch(`${mirrorNodeBase(chain)}/api/v1/contracts/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, data, gas: HEDERA_QUERY_GAS }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as {
      result?: unknown;
      _status?: { messages?: Array<{ message?: string }> };
    } | null;
    if (!res.ok || !body || typeof body.result !== "string" || body.result === "0x") {
      const detail = body?._status?.messages?.map((m) => m.message).join("; ");
      throw new Error(`Mirror-node contract call failed${detail ? `: ${detail}` : "."}`);
    }
    return body.result;
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(
        "Couldn't reach Hedera in time — check your connection and try again. Nothing was sent.",
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function createReadOnlySender(chain: ChainConfig): TxSender {
  // Read-only queries go through the official Hedera mirror node; ethers is
  // used only to encode/decode the calldata. The Hedera SDK
  // ContractCallQuery path is only needed for wallet-signed writes.
  return {
    kind: "hedera",
    account: "",
    async viewResolve(registryAddress, username) {
      try {
        const data = REGISTRY_IFACE.encodeFunctionData("resolvePage", [username]);
        const raw = await mirrorContractCall(chain, registryAddress, data);
        const [owner, ipfsHash, ownerType, operator, purpose] = REGISTRY_IFACE.decodeFunctionResult(
          "resolvePage",
          raw,
        ) as unknown as [string, string, bigint, string, string];
        return { owner, ipfsHash, ownerType: Number(ownerType) === 1 ? 1 : 0, operator, purpose };
      } catch {
        // resolvePage reverts with UsernameInvalid when the name is unknown.
        return null;
      }
    },
    async sendRegister() {
      throw new Error("Connect a wallet to send transactions.");
    },
    async sendUpdate() {
      throw new Error("Connect a wallet to send transactions.");
    },
    async sendTip() {
      throw new Error("Connect a wallet to send transactions.");
    },
    async sendBuy() {
      throw new Error("Connect a wallet to send transactions.");
    },
  };
}
