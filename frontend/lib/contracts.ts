/**
 * Voicescape contract calls.
 *
 * Thin wrappers over a TxSender (see lib/tx.ts). Reads (resolvePage) work
 * without a wallet via a public read-only sender; writes need a sender from
 * the connected wallet (useWallet().getTxSender()).
 *
 * Contract addresses come from env (set after `npx hardhat run scripts/deploy.js`),
 * with hardcoded Hedera mainnet addresses as fallback — Voicescape is
 * mainnet-only, so the fallback is always correct.
 *
 * Registry ABI matches the Phase B VoicescapeRegistry interface:
 *   registerPage(string username, string ipfsHash, uint8 ownerType, address operator, string purpose)
 *   resolvePage(string username) -> (address owner, string ipfsHash, uint8 ownerType, address operator, string purpose)
 * where ownerType 0 = HUMAN, 1 = AGENT.
 */
import type { ChainConfig } from "./chains";
import { createReadOnlySender, ZERO_ADDRESS, type ResolveResult, type TxSender } from "./tx";

export type { ResolveResult } from "./tx";
export { ZERO_ADDRESS };

const MAINNET_REGISTRY_ID = "0.0.10854058";
const MAINNET_REGISTRY_EVM = "0xd87F8113C5bcc47c40dC26a43fFa9B1629385a58";
const MAINNET_TIPS_ID = "0.0.10854060";
const MAINNET_TIPS_EVM = "0x571D6d0C5D5ee7Fc1e47283Ad864305b7f7A88e0";

export function getRegistryAddress(): string | undefined {
  return normalizeContractAddress(
    process.env.NEXT_PUBLIC_REGISTRY_ADDRESS,
    MAINNET_REGISTRY_ID,
    MAINNET_REGISTRY_EVM,
  );
}

export function getTipsAddress(): string | undefined {
  return normalizeContractAddress(
    process.env.NEXT_PUBLIC_TIPS_ADDRESS,
    MAINNET_TIPS_ID,
    MAINNET_TIPS_EVM,
  );
}

/**
 * Normalize a contract address env var without throwing. Falls back to the
 * hardcoded mainnet address when unset — Voicescape is mainnet-only, so the
 * known mainnet address is always correct. Returns undefined only when the
 * env var is set to an unmappable/unknown format (not mainnet, not EVM).
 * Read paths degrade gracefully (resolvePage returns null). Write-time
 * validation lives in require*Address() below plus hederaContractId() in
 * lib/tx.ts, so a bad value can never silently become a 0.0.0 transaction
 * at runtime, and it can never fail a build.
 */
function normalizeContractAddress(
  raw: string | undefined,
  knownHederaId: string,
  knownEvmAddress: string,
): string | undefined {
  const addr = raw?.trim();
  if (!addr) return knownEvmAddress; // unset → mainnet default
  // Ethers needs the 0x EVM address, not the 0.0.x Hedera ID.
  if (/^0\.0\.\d+$/.test(addr)) {
    return addr === knownHederaId ? knownEvmAddress : undefined;
  }
  return addr;
}

/**
 * Validated address for WRITE paths only. Throws at RUNTIME when a user
 * actually tries to transact — never at build time, because the write
 * functions below are only invoked from user actions and API handlers.
 * Error messages are user-facing: no env var names, no deployer jargon.
 */
export function requireRegistryAddress(): string {
  const addr = getRegistryAddress();
  if (!addr) {
    throw new Error(
      "Publishing is temporarily unavailable — please try again later.",
    );
  }
  if (addr.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    throw new Error(
      "Publishing is temporarily unavailable — please try again later.",
    );
  }
  return addr;
}

export function requireTipsAddress(): string {
  const addr = getTipsAddress();
  if (!addr) {
    throw new Error(
      "Tipping is temporarily unavailable — please try again later.",
    );
  }
  if (addr.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    throw new Error(
      "Tipping is temporarily unavailable — please try again later.",
    );
  }
  return addr;
}

/**
 * Look up a username in the page registry. No wallet needed.
 * Returns null when the username is not registered.
 */
export async function resolvePage(
  username: string,
  chain: ChainConfig,
): Promise<ResolveResult | null> {
  const addr = getRegistryAddress();
  if (!addr) return null; // not configured — read path degrades gracefully (build-safe)
  return createReadOnlySender(chain).viewResolve(addr, username);
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
  return sender.sendRegister(requireRegistryAddress(), username, ipfsHash, ownerType, operator, purpose);
}

/**
 * Update an existing page's IPFS hash. Needs a wallet-backed TxSender.
 */
export async function updatePage(
  username: string,
  ipfsHash: string,
  sender: TxSender,
): Promise<string> {
  return sender.sendUpdate(requireRegistryAddress(), username, ipfsHash);
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
  return sender.sendTip(requireTipsAddress(), username, valueWei);
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
  return sender.sendBuy(requireTipsAddress(), seller, listingRef, valueWei);
}
