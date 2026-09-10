/** Chain configs for Voicescape. RPC URLs come from env with public defaults. */

export type ChainKey = "hedera-testnet" | "hedera-mainnet";

export interface ChainConfig {
  key: ChainKey;
  label: string;
  chainId: number;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrl: string;
  blockExplorer: string;
}

export const CHAINS: Record<ChainKey, ChainConfig> = {
  "hedera-testnet": {
    key: "hedera-testnet",
    label: "Hedera Testnet",
    chainId: 296,
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrl:
      process.env.NEXT_PUBLIC_HEDERA_TESTNET_RPC ?? "https://testnet.hashio.io/api",
    blockExplorer: "https://hashscan.io/testnet",
  },
  "hedera-mainnet": {
    key: "hedera-mainnet",
    label: "Hedera Mainnet",
    chainId: 295,
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrl:
      process.env.NEXT_PUBLIC_HEDERA_MAINNET_RPC ?? "https://mainnet.hashio.io/api",
    blockExplorer: "https://hashscan.io/mainnet",
  },
};

export const ACTIVE_CHAIN_KEY: ChainKey = ((): ChainKey => {
  const raw = (process.env.NEXT_PUBLIC_CHAIN ?? "hedera-mainnet") as string;
  return raw in CHAINS ? (raw as ChainKey) : "hedera-mainnet";
})();

export function getActiveChain(): ChainConfig {
  return CHAINS[ACTIVE_CHAIN_KEY];
}
