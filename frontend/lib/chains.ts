/** Chain configs for Voicescape. RPC URLs come from env with public defaults. */

export type ChainKey = "hedera-testnet" | "hedera-mainnet" | "polygon-amoy" | "polygon";

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
  "polygon-amoy": {
    key: "polygon-amoy",
    label: "Polygon Amoy (testnet)",
    chainId: 80002,
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrl:
      process.env.NEXT_PUBLIC_POLYGON_AMOY_RPC ?? "https://rpc-amoy.polygon.technology",
    blockExplorer: "https://amoy.polygonscan.com",
  },
  polygon: {
    key: "polygon",
    label: "Polygon",
    chainId: 137,
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrl:
      process.env.NEXT_PUBLIC_POLYGON_MAINNET_RPC ?? "https://polygon-rpc.com",
    blockExplorer: "https://polygonscan.com",
  },
};

export const ACTIVE_CHAIN_KEY: ChainKey = ((): ChainKey => {
  const raw = (process.env.NEXT_PUBLIC_CHAIN ?? "hedera-testnet") as string;
  return raw in CHAINS ? (raw as ChainKey) : "hedera-testnet";
})();

export function getActiveChain(): ChainConfig {
  return CHAINS[ACTIVE_CHAIN_KEY];
}
