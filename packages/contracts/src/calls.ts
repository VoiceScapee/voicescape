/**
 * @voicescape/contracts — contract calls.
 *
 * Thin wrappers over a TxSender (see ./senders). Reads (resolvePage) work
 * without a wallet via a public read-only sender; writes need a sender from
 * the connected wallet (useWallet().getTxSender()).
 *
 * Registry ABI matches the Phase B VoicescapeRegistry interface:
 *   registerPage(string username, string ipfsHash, uint8 ownerType, address operator, string purpose)
 *   resolvePage(string username) -> (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)
 * where ownerType 0 = HUMAN, 1 = AGENT.
 */
import type { ChainConfig, ResolveResult, TxSender } from "@voicescape/wallet";
import { createReadOnlySender } from "./senders";
import { getRegistryAddress, getTipsAddress } from "./addresses";

export type { ResolveResult } from "@voicescape/wallet";

/**
 * Look up a username in the page registry. No wallet needed.
 * Returns null when the username is not registered.
 */
export async function resolvePage(
  username: string,
  chain: ChainConfig,
): Promise<ResolveResult | null> {
  return createReadOnlySender(chain).viewResolve(getRegistryAddress(), username);
}

/**
 * Register a new page (first publish). Needs a wallet-backed TxSender.
 * ownerType: 0 = human, 1 = agent. Agents MUST pass their operator wallet
 * and a purpose disclosure (the contract reverts otherwise); humans pass
 * ZERO_ADDRESS + "".
 * Resolves to the transaction hash (EVM) or transaction id (Hedera).
 */
export async function registerPage(
  username: string,
  ipfsHash: string,
  ownerType: 0 | 1,
  operator: string,
  purpose: string,
  sender: TxSender,
): Promise<string> {
  return sender.sendRegister(getRegistryAddress(), username, ipfsHash, ownerType, operator, purpose);
}

/**
 * Update an existing page's IPFS hash. Needs a wallet-backed TxSender.
 */
export async function updatePage(
  username: string,
  ipfsHash: string,
  sender: TxSender,
): Promise<string> {
  return sender.sendUpdate(getRegistryAddress(), username, ipfsHash);
}

/**
 * Send a tip to a page owner. The Tips contract splits 98% to the owner
 * and 2% to the treasury on-chain. Needs a wallet-backed TxSender.
 * valueWei uses 18 decimals on every supported chain.
 */
export async function tipPage(
  username: string,
  valueWei: bigint,
  sender: TxSender,
): Promise<string> {
  return sender.sendTip(getTipsAddress(), username, valueWei);
}

/**
 * Buy a marketplace listing. One wallet transaction: the Tips contract
 * splits 98% to the seller and 2% to the treasury atomically. The contract
 * never holds buyer funds — there is no escrow. Delivery happens off-chain.
 * Needs a wallet-backed TxSender. valueWei uses 18 decimals on every chain.
 */
export async function buyListing(
  seller: string,
  listingRef: string,
  valueWei: bigint,
  sender: TxSender,
): Promise<string> {
  return sender.sendBuy(getTipsAddress(), seller, listingRef, valueWei);
}
