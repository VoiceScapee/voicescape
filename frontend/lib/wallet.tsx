"use client";

/**
 * Wallet abstraction for Voicescape.
 *
 * One interface, multiple adapters:
 *  - Hedera (HashPack, Blade, WalletConnect): paired through HashConnect v3
 *    (WalletConnect-based). Contract calls go through @hashgraph/sdk
 *    transactions signed in the wallet — see lib/tx.ts.
 *  - Polygon (MetaMask): injected window.ethereum provider + ethers v6.
 *
 * HashConnect pairing needs a WalletConnect project id:
 *   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID (free at https://cloud.reown.com)
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { ethers } from "ethers";
import type { HashConnect } from "hashconnect";
import { getActiveChain, type ChainConfig } from "./chains";
import { createEvmTxSender, createHederaTxSender, type TxSender } from "./tx";

export interface WalletState {
  account: string | null;
  chainId: number | null;
  adapterName: string | null;
  isConnecting: boolean;
  error: string | null;
  connect: (adapter: WalletAdapterId) => Promise<string | null>;
  disconnect: () => Promise<void>;
  /** TxSender bound to the current connection. Throws when not connected. */
  getTxSender: () => Promise<TxSender>;
}

export type WalletAdapterId = "hashpack" | "blade" | "walletconnect" | "metamask";

export const WALLET_ADAPTERS: { id: WalletAdapterId; name: string; chains: string[] }[] = [
  { id: "hashpack", name: "HashPack", chains: ["hedera-testnet", "hedera-mainnet"] },
  { id: "blade", name: "Blade", chains: ["hedera-testnet", "hedera-mainnet"] },
  { id: "walletconnect", name: "WalletConnect", chains: ["hedera-testnet", "hedera-mainnet"] },
  { id: "metamask", name: "MetaMask", chains: ["polygon-amoy", "polygon"] },
];

/* ------------------------------------------------------------------ */
/* Shared Hedera pairing via HashConnect v3                             */
/* ------------------------------------------------------------------ */

let hcInstance: HashConnect | null = null;
let hcAccountId: string | null = null;

function getPairingProjectId(): string {
  const pid = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  if (!pid) {
    throw new Error(
      "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set. Create a free project at https://cloud.reown.com and add the id to your .env to enable Hedera wallet pairing.",
    );
  }
  return pid;
}

async function disconnectHedera(): Promise<void> {
  if (hcInstance) {
    try {
      await hcInstance.disconnect();
    } catch {
      // Best effort.
    }
    hcInstance = null;
    hcAccountId = null;
  }
}

/**
 * Access the live Hedera pairing for wallet-backed flows that need more
 * than contract calls — e.g. signing x402 payment transactions or direct
 * token transfers. Returns null when no Hedera wallet is paired.
 */
export function getHederaPairing(): { hc: HashConnect; accountId: string } | null {
  if (!hcInstance || !hcAccountId) return null;
  return { hc: hcInstance, accountId: hcAccountId };
}

/**
 * Pair a Hedera wallet through HashConnect v3.
 *
 * Flow (per the hashconnect 3.x API): construct HashConnect with the ledger
 * id + WalletConnect project id + dapp metadata, attach a pairingEvent
 * listener, init() (a HashPack browser extension auto-pairs here when
 * present), otherwise openPairingModal() for QR-based pairing with any
 * HIP-820 wallet (HashPack mobile, Blade, Kabila…).
 */
async function connectHederaWallet(chain: ChainConfig): Promise<string> {
  const [{ HashConnect }, { LedgerId }] = await Promise.all([
    import("hashconnect"),
    import("@hashgraph/sdk"),
  ]);
  await disconnectHedera();

  const ledgerId = chain.key === "hedera-mainnet" ? LedgerId.MAINNET : LedgerId.TESTNET;
  const hc = new HashConnect(
    ledgerId,
    getPairingProjectId(),
    {
      name: "Voicescape",
      description: "MySpace-style block pages with on-chain tipping",
      icons: [`${window.location.origin}/icon.svg`],
      url: window.location.origin,
    },
    false,
  );
  hcInstance = hc;

  const pairingPromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Pairing timed out — approve the connection in your wallet and try again.")),
      180_000,
    );
    hc.pairingEvent.on((data) => {
      const id = data.accountIds?.[0];
      if (id) {
        clearTimeout(timer);
        resolve(id);
      }
    });
  });

  await hc.init();

  // An installed HashPack extension pairs automatically during init().
  const autoPaired = hc.connectedAccountIds;
  if (autoPaired.length > 0) {
    hcAccountId = autoPaired[0].toString();
    return hcAccountId;
  }

  await hc.openPairingModal("dark");
  hcAccountId = await pairingPromise;
  return hcAccountId;
}

function hederaGetTxSender(chain: ChainConfig): () => Promise<TxSender> {
  return async () => {
    if (!hcInstance || !hcAccountId) {
      throw new Error("Hedera wallet is not connected.");
    }
    return createHederaTxSender(hcInstance, hcAccountId, chain);
  };
}

/* ------------------------------------------------------------------ */
/* Adapter implementations                                              */
/* ------------------------------------------------------------------ */

interface WalletAdapter {
  id: WalletAdapterId;
  connect(chain: ChainConfig): Promise<{
    account: string;
    chainId: number;
    getTxSender: () => Promise<TxSender>;
  }>;
  disconnect(): Promise<void>;
}

function makeHederaAdapter(id: WalletAdapterId): WalletAdapter {
  return {
    id,
    async connect(chain: ChainConfig) {
      const account = await connectHederaWallet(chain);
      const chainId = chain.chainId;
      return { account, chainId, getTxSender: hederaGetTxSender(chain) };
    },
    async disconnect() {
      await disconnectHedera();
    },
  };
}

function getInjectedEthereum(): { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } {
  const eth = (window as unknown as { ethereum?: unknown }).ethereum as
    | { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }
    | undefined;
  if (!eth?.request) {
    throw new Error("No EVM wallet detected. Install MetaMask and try again.");
  }
  return eth;
}

const metamaskAdapter: WalletAdapter = {
  id: "metamask",
  async connect(chain: ChainConfig) {
    const eth = getInjectedEthereum();
    const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts?.[0]) throw new Error("The wallet returned no accounts.");

    // Best effort: move the wallet onto the app's active chain.
    const targetChainIdHex = `0x${chain.chainId.toString(16)}`;
    try {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetChainIdHex }],
      });
    } catch (switchErr: unknown) {
      const code = (switchErr as { code?: number })?.code;
      if (code === 4902) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: targetChainIdHex,
              chainName: chain.label,
              nativeCurrency: {
                name: chain.nativeCurrency.name,
                symbol: chain.nativeCurrency.symbol,
                decimals: chain.nativeCurrency.decimals,
              },
              rpcUrls: [chain.rpcUrl],
              blockExplorerUrls: [chain.blockExplorer],
            },
          ],
        });
      } else {
        throw switchErr;
      }
    }

    const chainIdHex = (await eth.request({ method: "eth_chainId" })) as string;
    const walletChainId = parseInt(chainIdHex, 16);
    if (walletChainId !== chain.chainId) {
      throw new Error(
        `Wallet is on chain ${walletChainId} but Voicescape is configured for ${chain.label} (${chain.chainId}). Switch networks in your wallet and try again.`,
      );
    }

    const account = accounts[0];
    const ethForProvider = eth;
    const getTxSender = async (): Promise<TxSender> => {
      const provider = new ethers.BrowserProvider(ethForProvider as ethers.Eip1193Provider);
      const signer = await provider.getSigner();
      return createEvmTxSender(provider, signer, account);
    };
    return { account, chainId: walletChainId, getTxSender };
  },
  async disconnect() {
    // MetaMask exposes no programmatic disconnect; clearing local state is enough.
  },
};

const ADAPTERS: Record<WalletAdapterId, WalletAdapter> = {
  hashpack: makeHederaAdapter("hashpack"),
  // Blade and generic WalletConnect pair through the same WalletConnect-based
  // HashConnect modal, which supports any HIP-820 Hedera wallet.
  blade: makeHederaAdapter("blade"),
  walletconnect: makeHederaAdapter("walletconnect"),
  metamask: metamaskAdapter,
};

/* ------------------------------------------------------------------ */
/* React context + hook                                                 */
/* ------------------------------------------------------------------ */

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [adapterName, setAdapterName] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const senderGetter = React.useRef<(() => Promise<TxSender>) | null>(null);

  const connect = useCallback(async (adapterId: WalletAdapterId) => {
    setIsConnecting(true);
    setError(null);
    try {
      const chain = getActiveChain();
      const adapter = ADAPTERS[adapterId];
      const result = await adapter.connect(chain);
      senderGetter.current = result.getTxSender;
      setAccount(result.account);
      setChainId(result.chainId);
      setAdapterName(adapterId);
      return result.account;
    } catch (e) {
      senderGetter.current = null;
      setError(e instanceof Error ? e.message : "Failed to connect wallet");
      // Clean up a half-opened Hedera session on failure.
      await disconnectHedera();
      return null;
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (adapterName) {
      try {
        await ADAPTERS[adapterName as WalletAdapterId].disconnect();
      } catch {
        // Best effort — clear local state regardless.
      }
    }
    senderGetter.current = null;
    setAccount(null);
    setChainId(null);
    setAdapterName(null);
  }, [adapterName]);

  const getTxSender = useCallback(async (): Promise<TxSender> => {
    if (!senderGetter.current) throw new Error("Connect a wallet first.");
    return senderGetter.current();
  }, []);

  const value = useMemo<WalletState>(
    () => ({ account, chainId, adapterName, isConnecting, error, connect, disconnect, getTxSender }),
    [account, chainId, adapterName, isConnecting, error, connect, disconnect, getTxSender],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}

