/**
 * @voicescape/wallet — shared types for the wallet layer.
 *
 * Pure types and constants only (no SDK imports). The TxSender interface is
 * the boundary between wallet connection (this package) and transaction
 * construction (@voicescape/contracts). Concrete senders are created by the
 * factories in @voicescape/contracts and dynamically imported by the
 * wallet provider so the ~2.3MB @hashgraph/sdk never lands in the initial
 * bundle.
 */

/** Result of resolving a username in the page registry. */
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
 * One interface for Voicescape contract calls, implemented per wallet family:
 *
 * - EVM (MetaMask on Hedera): ethers v6 against the chain's JSON-RPC.
 *   Reads go through a public JsonRpcProvider; writes use the wallet signer.
 * - Hedera (HashPack / Blade / WalletConnect): the same Solidity contracts
 *   are called through @hashgraph/sdk ContractExecuteTransaction /
 *   ContractCallQuery, signed in the wallet.
 */
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
