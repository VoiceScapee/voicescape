/**
 * EVM wallet writes for Voicescape (MetaMask-style wallets, chain 295).
 *
 * Lets humans and agents that already speak EVM tooling submit Voicescape
 * contract calls — tipPage / buyListing on the existing Tips contract —
 * through their own wallet, without learning Hedera-native wallets.
 * The calls land on Hedera mainnet as ETHEREUMTRANSACTIONs via the
 * JSON-RPC relay; the 98/2 split still happens inside the Tips contract
 * itself, so EVM writers get exactly the same economics as Hedera
 * writers. No new contract is deployed for this path.
 *
 * DELIBERATE CONSTRAINTS (deploy gate):
 * - No wagmi, web3.js, thirdweb, or any chain-connection library. The
 *   wallet's own injected EIP-1193 provider (`window.ethereum`) is
 *   called directly with `request()` — that is the wallet's API, not a
 *   library. ethers is used ONLY to encode calldata (its allowed use);
 *   no ethers provider or signer is ever constructed.
 * - This module SUBMITS and returns a transaction hash. It never
 *   credits, confirms, or displays a payment as received. The proof is
 *   server-side mirror-node verification (lib/server/evm-verify.ts:
 *   verifyTipSent for tips) — a relay receipt or wallet confirmation is
 *   only a hint. UI wiring must gate any "received" state on that
 *   verification, the same way Hedera-native writes gate on mirror-node
 *   confirmation.
 * - Value units: eth_sendTransaction's value field is standard EVM wei.
 *   The relay maps it onto the Hedera transaction; the submitted value
 *   is NOT the verification source — the mirror-node TipSent gross
 *   tinybar is. Callers converting an HBAR amount to wei must do so in
 *   the UI layer, and the server must still verify the tinybar gross.
 * - Live-wallet testing is impossible in this VM (browser extensions
 *   cannot install here) — the first real MetaMask round-trip must be
 *   Brandon's phone test before any UI wiring ships.
 */

import { Interface } from "ethers";
import { getRelayUrl } from "./evm-relay";

/** Hedera mainnet EVM chain id. */
export const HEDERA_MAINNET_CHAIN_ID = 295;
export const HEDERA_MAINNET_CHAIN_ID_HEX = "0x127";

/**
 * 1 tinybar = 10^10 wei. Hedera docs (evm/development/troubleshooting,
 * "Decimal handling: 8 vs 18"): the native ledger uses 8 decimals, the
 * JSON-RPC relay scales values to 18-decimal wei, and inside an EVM
 * contract msg.value is wei. Same constant as WEI_PER_TINYBAR in lib/tx.ts
 * (the Hedera-native write path) — if either changes, both must change.
 */
export const WEI_PER_TINYBAR = 10_000_000_000n;

/** Exact tinybar → EVM wei conversion (integer math, never floats for money). */
export function tinybarToWei(tinybar: bigint): bigint {
  if (tinybar < 0n) throw new EvmWalletError("Tinybar amount cannot be negative.");
  return tinybar * WEI_PER_TINYBAR;
}

export class EvmWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvmWalletError";
  }
}

/** Minimal EIP-1193 provider surface — structural, so any injected wallet qualifies. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** The injected wallet provider, or null when none is present (server render, no wallet). */
export function getEvmProvider(): Eip1193Provider | null {
  const ethereum = (globalThis as { ethereum?: unknown }).ethereum;
  if (!ethereum || typeof ethereum !== "object") return null;
  const request = (ethereum as { request?: unknown }).request;
  if (typeof request !== "function") return null;
  return ethereum as Eip1193Provider;
}

/** True when the provider error is a user rejection (EIP-1193 code 4001). */
export function isUserRejection(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === 4001
  );
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(v) ? v : null;
}

/** Connected EVM account (lowercase), or throws when none is available. */
export async function requestEvmAccount(provider: Eip1193Provider): Promise<string> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as unknown;
  const first = Array.isArray(accounts) ? accounts[0] : null;
  const account = normalizeAddress(first);
  if (!account) throw new EvmWalletError("No EVM account is connected.");
  return account;
}

/**
 * Ensure the wallet is on Hedera mainnet (chain 295). Switches chains,
 * or adds the network (with the configured relay as RPC) when the wallet
 * reports it missing (error 4902). A user rejection propagates untouched
 * so the UI can tell "declined" apart from "broken".
 */
export async function ensureHederaMainnet(
  provider: Eip1193Provider,
  relayUrl?: string,
): Promise<void> {
  const chainId = (await provider.request({ method: "eth_chainId" })) as unknown;
  if (typeof chainId === "string" && chainId.toLowerCase() === HEDERA_MAINNET_CHAIN_ID_HEX) return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: HEDERA_MAINNET_CHAIN_ID_HEX }],
    });
  } catch (error) {
    if (isUserRejection(error)) throw error;
    const code = (error as { code?: unknown }).code;
    if (code !== 4902) {
      throw new EvmWalletError("Could not switch the wallet to Hedera mainnet.");
    }
    const rpcUrl = relayUrl ?? getRelayUrl();
    if (!rpcUrl) {
      throw new EvmWalletError(
        "Hedera mainnet is not in this wallet and no relay URL is configured to add it.",
      );
    }
    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: HEDERA_MAINNET_CHAIN_ID_HEX,
            chainName: "Hedera Mainnet",
            nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
            rpcUrls: [rpcUrl],
            blockExplorerUrls: ["https://hashscan.io/mainnet"],
          },
        ],
      });
    } catch (addError) {
      if (isUserRejection(addError)) throw addError;
      throw new EvmWalletError("Could not add Hedera mainnet to the wallet.");
    }
  }
}

export interface EvmSendInput {
  /** Destination contract address (0x…). */
  to: string;
  /** Encoded calldata (0x…). */
  data: string;
  /** EVM wei value. */
  valueWei: bigint;
}

/**
 * Submit one EVM transaction through the wallet. Returns the transaction
 * hash — NOT a confirmation. The wallet/relay estimates gas; this module
 * sets no gas fields on purpose (a wrong manual limit is a classic way
 * to burn a fee on a reverted call).
 */
export async function sendEvmTransaction(
  provider: Eip1193Provider,
  input: EvmSendInput,
): Promise<string> {
  const to = normalizeAddress(input.to);
  if (!to) throw new EvmWalletError("Destination address is invalid.");
  if (typeof input.data !== "string" || !/^0x[0-9a-f]*$/.test(input.data)) {
    throw new EvmWalletError("Calldata is invalid.");
  }
  if (input.valueWei < 0n) throw new EvmWalletError("Value cannot be negative.");
  const txHash = (await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        to,
        data: input.data,
        value: "0x" + input.valueWei.toString(16),
      },
    ],
  })) as unknown;
  if (typeof txHash !== "string" || !/^0x[0-9a-f]{64}$/.test(txHash)) {
    throw new EvmWalletError("Wallet did not return a transaction hash.");
  }
  return txHash;
}

/**
 * Tips contract call fragments. The strings are identical to TIPS_ABI in
 * lib/tx.ts (verified against the deployed Tips contract) — duplicated
 * here rather than imported so this module stays free of the Hiero SDK
 * import graph. If the Tips contract ever changes, both must change.
 */
const TIPS_CALL_ABI = [
  "function tipPage(string username) payable",
  "function buyListing(address seller, string listingRef) payable",
] as const;

const tipsInterface = new Interface(TIPS_CALL_ABI);

/** Encoded tipPage(username) calldata (ethers encode-only use). */
export function buildTipCalldata(username: string): string {
  if (typeof username !== "string" || !username.trim()) {
    throw new EvmWalletError("Username is required to build a tip call.");
  }
  return tipsInterface.encodeFunctionData("tipPage", [username]);
}

/** Encoded buyListing(seller, listingRef) calldata (ethers encode-only use). */
export function buildBuyCalldata(seller: string, listingRef: string): string {
  if (!normalizeAddress(seller)) throw new EvmWalletError("Seller address is invalid.");
  if (typeof listingRef !== "string" || !listingRef.trim()) {
    throw new EvmWalletError("Listing reference is required to build a purchase call.");
  }
  return tipsInterface.encodeFunctionData("buyListing", [seller, listingRef]);
}

export interface EvmSubmitResult {
  /** Submitted transaction hash (unconfirmed — verify via mirror node). */
  txHash: string;
  /** Submitting EVM account (lowercase). */
  from: string;
}

export interface SubmitEvmTipInput {
  /** Tips contract EVM address (0x…). */
  tipsAddress: string;
  username: string;
  /** Tip amount in EVM wei. */
  valueWei: bigint;
  /** Relay URL for the add-network case; defaults to the configured relay. */
  relayUrl?: string;
}

/**
 * Full EVM tip flow: connect, ensure Hedera mainnet, submit tipPage.
 * Returns the hash + sender for server-side mirror-node verification
 * (verifyTipSent) — the caller must NOT treat this as received.
 */
export async function submitEvmTip(
  provider: Eip1193Provider,
  input: SubmitEvmTipInput,
): Promise<EvmSubmitResult> {
  const from = await requestEvmAccount(provider);
  await ensureHederaMainnet(provider, input.relayUrl);
  const txHash = await sendEvmTransaction(provider, {
    to: input.tipsAddress,
    data: buildTipCalldata(input.username),
    valueWei: input.valueWei,
  });
  return { txHash, from };
}

export interface SubmitEvmBuyInput {
  /** Tips contract EVM address (0x…). */
  tipsAddress: string;
  seller: string;
  listingRef: string;
  /** Purchase amount in EVM wei. */
  valueWei: bigint;
  /** Relay URL for the add-network case; defaults to the configured relay. */
  relayUrl?: string;
}

/** Full EVM marketplace-purchase flow (buyListing), same proof rules as submitEvmTip. */
export async function submitEvmBuy(
  provider: Eip1193Provider,
  input: SubmitEvmBuyInput,
): Promise<EvmSubmitResult> {
  const from = await requestEvmAccount(provider);
  await ensureHederaMainnet(provider, input.relayUrl);
  const txHash = await sendEvmTransaction(provider, {
    to: input.tipsAddress,
    data: buildBuyCalldata(input.seller, input.listingRef),
    valueWei: input.valueWei,
  });
  return { txHash, from };
}
