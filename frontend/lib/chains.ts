/**
 * Chain config for Voicescape. Hedera mainnet only — no testnet
 * (Brandon's rule 2026-09-28: everything shipped is production-grade mainnet).
 * RPC URL comes from env with a public default.
 */

export type ChainKey = "hedera-mainnet";

export interface ChainConfig {
  key: ChainKey;
  label: string;
  chainId: number;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrl: string;
  blockExplorer: string;
}

export const CHAINS: Record<ChainKey, ChainConfig> = {
  "hedera-mainnet": {
    key: "hedera-mainnet",
    label: "Hedera Mainnet",
    chainId: 295,
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrl:
      // KISS: Vercel has this var set but EMPTY — ?? doesn't catch "".
      // Use trim() || fallback so an empty var doesn't break all RPC calls.
      process.env.NEXT_PUBLIC_HEDERA_MAINNET_RPC?.trim() || "https://mainnet.hashio.io/api",
    blockExplorer: "https://hashscan.io/mainnet",
  },
};

export const ACTIVE_CHAIN_KEY: ChainKey = "hedera-mainnet";

export function getActiveChain(): ChainConfig {
  return CHAINS[ACTIVE_CHAIN_KEY];
}
