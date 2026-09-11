"use client";

/**
 * Wallet abstraction for Voicescape.
 *
 * One interface, multiple adapters:
 *  - Hedera (HashPack, Blade, WalletConnect): paired through DAppConnector
 *    from @hashgraph/hedera-wallet-connect (official, HIP-820 based).
 *    Contract calls go through @hashgraph/sdk transactions signed in the
 *    wallet — see lib/tx.ts.
 *  - MetaMask: injected window.ethereum provider + ethers v6, pointed at
 *    Hedera (adds/switches to the Hedera network automatically).
 *
 * Hedera pairing needs a WalletConnect project id:
 *   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID (free at https://cloud.reown.com)
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ethers } from "ethers";
import type { DAppConnector } from "@hashgraph/hedera-wallet-connect";
import { getActiveChain, type ChainConfig } from "./chains";
import type { TxSender } from "./tx";
// NOTE: ./tx is intentionally NOT statically imported here. It pulls in the
// entire @hashgraph/sdk (~2.3MB) which Vercel's CDN fails to serve reliably
// on mobile ("Loading chunk 3322 failed"). The tx senders are dynamically
// imported only when actually signing a transaction (after wallet connection).
// The @hashgraph/hedera-wallet-connect package is also dynamically imported
// for the same reason + SSR safety.

/**
 * Minimal LedgerId shim — the real SDK LedgerId is just a 1-byte wrapper
 * ([0]=mainnet, [1]=testnet) with a toString() method. DAppConnector only
 * calls toString() on it (via ledgerIdToCAIPChainId), so we avoid pulling
 * the entire 2.3MB SDK into the wallet connection chunk for this one
 * trivial class.
 */
class MinimalLedgerId {
  private readonly byte: number;
  private constructor(byte: number) {
    this.byte = byte;
  }
  toString(): string {
    return this.byte === 0 ? "mainnet" : this.byte === 1 ? "testnet" : "previewnet";
  }
  toBytes(): Uint8Array {
    return new Uint8Array([this.byte]);
  }
  isMainnet(): boolean {
    return this.byte === 0;
  }
  isTestnet(): boolean {
    return this.byte === 1;
  }
  static readonly MAINNET = new MinimalLedgerId(0);
  static readonly TESTNET = new MinimalLedgerId(1);
  static readonly PREVIEWNET = new MinimalLedgerId(2);
}

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
  { id: "metamask", name: "MetaMask", chains: ["hedera-testnet", "hedera-mainnet"] },
];

/* ------------------------------------------------------------------ */
/* HashPack in-app (dApp) browser detection                             */
/* ------------------------------------------------------------------ */

/**
 * Signals used to detect HashPack's built-in dApp browser. Kept as a pure
 * function of its inputs so it can be unit-tested without a DOM.
 */
export function detectHashPackInAppBrowser(signals: {
  hasInjectedHashpack: boolean;
  userAgent: string;
}): boolean {
  if (signals.hasInjectedHashpack) return true;
  return /hashpack/i.test(signals.userAgent);
}

/**
 * True when the page is running inside HashPack's in-app browser (or the
 * HashPack extension has injected its provider). HashPack injects
 * `window.hashpack` there; the user agent is checked as a secondary
 * signal. In that environment the wallet is one tap away — the QR pairing
 * modal is never useful, and the app auto-connects on mount instead of
 * waiting for the user to pick a wallet.
 */
export function isHashPackInAppBrowser(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { hashpack?: unknown };
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return detectHashPackInAppBrowser({
    hasInjectedHashpack: w.hashpack !== undefined && w.hashpack !== null,
    userAgent: ua,
  });
}

/* ------------------------------------------------------------------ */
/* Shared Hedera pairing via DAppConnector                              */
/* ------------------------------------------------------------------ */

let dAppConnectorInstance: DAppConnector | null = null;
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
  if (dAppConnectorInstance) {
    try {
      await dAppConnectorInstance.disconnectAll();
    } catch {
      // Best effort.
    }
    dAppConnectorInstance = null;
    hcAccountId = null;
  }
}

/**
 * Access the live Hedera pairing for wallet-backed flows that need more
 * than contract calls — e.g. signing x402 payment transactions or direct
 * token transfers. Returns null when no Hedera wallet is paired.
 */
export function getHederaPairing(): { hc: DAppConnector; accountId: string } | null {
  if (!dAppConnectorInstance || !hcAccountId) return null;
  return { hc: dAppConnectorInstance, accountId: hcAccountId };
}

/**
 * Extract the account ID from a WalletConnect session.
 * Session accounts look like "hedera:mainnet:0.0.12345" (HIP-30 format).
 */
function accountIdFromSession(session: { namespaces?: Record<string, { accounts?: string[] }> }): string | null {
  const accounts = session.namespaces?.hedera?.accounts;
  if (!accounts || accounts.length === 0) return null;
  // Format: "hedera:<network>:<accountId>" → take the last part
  const parts = accounts[0].split(":");
  return parts[parts.length - 1] || null;
}

/**
 * Pair a Hedera wallet through DAppConnector (@hashgraph/hedera-wallet-connect).
 *
 * Flow: construct DAppConnector with dapp metadata + ledger id + WalletConnect
 * project id, init(), then openModal() for QR-based pairing with any HIP-820
 * wallet (HashPack mobile, Blade, Kabila…). Inside HashPack's in-app browser
 * the pairing happens via the iframe callback instead of a QR modal.
 */
async function connectHederaWallet(chain: ChainConfig): Promise<string> {
  // Dynamic import keeps the wallet library out of the initial bundle and
  // avoids SSR issues (the package touches browser APIs at import time).
  // NOTE: We deliberately do NOT import @hashgraph/sdk here — it creates a
  // 2.3MB chunk that Vercel's CDN fails to serve on mobile (ChunkLoadError).
  // LedgerId is replaced by the MinimalLedgerId shim above; the full SDK
  // (via ./tx) is only loaded when actually signing a transaction.
  const {
    DAppConnector: DAppConnectorClass,
    HederaJsonRpcMethod,
    HederaSessionEvent,
    HederaChainId,
  } = await import("@hashgraph/hedera-wallet-connect");

  await disconnectHedera();

  const isMainnet = chain.key === "hedera-mainnet";
  // MinimalLedgerId shim: DAppConnector only calls toString() on the ledger id.
  const ledgerId = (isMainnet ? MinimalLedgerId.MAINNET : MinimalLedgerId.TESTNET) as unknown as never;

  const connector = new DAppConnectorClass(
    {
      name: "Voicescape",
      description: "Block pages for humans and AI agents, with on-chain tipping",
      url: window.location.origin,
      icons: [`${window.location.origin}/icon.svg`],
    },
    ledgerId,
    getPairingProjectId(),
    Object.values(HederaJsonRpcMethod),
    [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
    [isMainnet ? HederaChainId.Mainnet : HederaChainId.Testnet],
  );
  dAppConnectorInstance = connector;

  await connector.init({ logger: "error" });

  // Inside HashPack's in-app browser a QR pairing modal is useless — it
  // can't be scanned from within the wallet app itself. The pairing
  // happens via the iframe session callback instead.
  const inHashPackBrowser = isHashPackInAppBrowser();

  if (inHashPackBrowser) {
    // Wait for the iframe-based pairing (up to 3 minutes).
    const accountId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "HashPack did not approve the connection — approve the request in HashPack and try again.",
            ),
          ),
        180_000,
      );
      connector.onSessionIframeCreated = (session) => {
        const id = accountIdFromSession(session);
        if (id) {
          clearTimeout(timer);
          resolve(id);
        }
      };
    });
    hcAccountId = accountId;
    return accountId;
  }

  // Standard flow: open the QR pairing modal.
  // Note: if a desktop extension is present, the modal offers it directly.
  let session;
  try {
    session = await connector.openModal();
  } catch (modalErr) {
    const msg = modalErr instanceof Error ? modalErr.message : String(modalErr);
    throw new Error(
      `Could not open the wallet pairing screen (${msg}). Try the WalletConnect option instead, or open this page in your wallet's built-in browser.`,
    );
  }

  const accountId = accountIdFromSession(session);
  if (!accountId) {
    throw new Error("Pairing succeeded but no Hedera account was returned.");
  }
  hcAccountId = accountId;
  return accountId;
}

function hederaGetTxSender(chain: ChainConfig): () => Promise<TxSender> {
  return async () => {
    if (!dAppConnectorInstance || !hcAccountId) {
      throw new Error("Hedera wallet is not connected.");
    }
    // Dynamic import: ./tx pulls in @hashgraph/sdk (~2.3MB). Only load it
    // when actually signing — never on page load or wallet connection.
    const { createHederaTxSender } = await import("./tx");
    return createHederaTxSender(dAppConnectorInstance, hcAccountId, chain);
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
      // Dynamic import keeps @hashgraph/sdk out of the initial bundle.
      const { createEvmTxSender } = await import("./tx");
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
  // modal, which supports any HIP-820 Hedera wallet.
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
      const msg = e instanceof Error ? e.message : "Failed to connect wallet";
      setError(msg);
      // Clean up a half-opened Hedera session on failure.
      await disconnectHedera();
      // Re-throw so callers get the actual error immediately (React state
      // updates are async, so reading wallet.error right after connect()
      // would see the stale null value).
      throw new Error(msg);
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

  /* Auto-connect inside HashPack's in-app browser: the wallet is already
     at hand there, so connect on mount instead of making the user tap
     through a wallet picker. The 7-day session still requires one
     explicit signature (handled by the session layer) — authentication
     is never skipped. Failures surface via wallet.error and the manual
     "Sign in with wallet" picker stays available as a fallback. */
  const autoConnectTried = useRef(false);
  useEffect(() => {
    if (autoConnectTried.current) return;
    if (account) return;
    if (!isHashPackInAppBrowser()) return;
    autoConnectTried.current = true;
    void connect("hashpack").catch(() => {
      // connect() already recorded the specific failure in wallet.error
      // and rethrows; swallow the rethrow here since the error state is
      // the user-visible signal.
    });
  }, [connect, account]);

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
