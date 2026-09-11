/**
 * @voicescape/wallet — public API.
 *
 * Wallet connection layer: HashPack / Blade / WalletConnect via Hedera's
 * official DAppConnector, plus MetaMask (EVM) pointed at Hedera.
 */
export {
  WalletProvider,
  useWallet,
  WALLET_ADAPTERS,
  detectHashPackInAppBrowser,
  isHashPackInAppBrowser,
  getHederaPairing,
} from "./wallet";
export type { WalletState, WalletAdapterId } from "./wallet";
export { getActiveChain, CHAINS } from "./chains";
export type { ChainConfig, ChainKey } from "./chains";
export { ZERO_ADDRESS } from "./types";
export type { TxSender, ResolveResult } from "./types";
