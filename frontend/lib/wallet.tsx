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
 *
 * NOTE: HashPack's iOS in-app browser provides NEITHER signal (no
 * `window.hashpack` injection, no "hashpack" in the WKWebView user agent),
 * so this returns false there. Use `isHashPackInAppBrowserAsync()` when
 * you need a reliable answer on iOS.
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

/**
 * True on a mobile user agent (phone/tablet). Used to decide whether the
 * iframe-channel probe is worth the wait: on desktop the WalletConnect
 * modal is always the right fallback, so we skip the probe and show it
 * immediately.
 */
export function isMobileUserAgent(ua?: string): boolean {
  const agent =
    ua ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  return /iPhone|iPad|iPod|Android|Mobile/i.test(agent);
}

/**
 * Probe for a wallet in-app browser via the iframe postMessage channel.
 * Posts `hedera-iframe-query` to the parent frame and waits for a
 * `hedera-iframe-response` — the same handshake DAppConnector uses for
 * in-app discovery, so it's platform-agnostic: it works in HashPack's iOS
 * in-app browser, which provides no `window.hashpack` injection or UA
 * signal. Resolves true when a wallet answers, false on timeout. Never
 * rejects.
 */
export function probeInAppWallet(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve(false);
      return;
    }
    const w = window as unknown as { hashpack?: unknown };
    if (w.hashpack !== undefined && w.hashpack !== null) {
      resolve(true);
      return;
    }
    const onMessage = (event: MessageEvent) => {
      const data = event?.data as
        | { type?: string; metadata?: unknown }
        | undefined;
      if (data?.type === "hedera-iframe-response" && data.metadata) {
        cleanup();
        resolve(true);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
    window.addEventListener("message", onMessage);
    try {
      // The wallet's in-app container answers from the parent frame.
      // A top-level page posts to itself — harmless, nothing answers.
      window.parent.postMessage({ type: "hedera-iframe-query" }, "*");
    } catch {
      cleanup();
      resolve(false);
    }
  });
}

/**
 * Reliable in-app browser detection, including iOS. Synchronous signals
 * first (fast path); on mobile, falls back to a brief iframe-channel
 * probe, which is the only signal HashPack's iOS in-app browser provides.
 * Resolves false on desktop without probing so the pairing modal appears
 * without delay there.
 */
export async function isHashPackInAppBrowserAsync(): Promise<boolean> {
  if (isHashPackInAppBrowser()) return true;
  if (!isMobileUserAgent()) return false;
  return probeInAppWallet(IN_APP_PROBE_TIMEOUT_MS);
}

/** How long the mobile iframe-channel probe waits for a wallet answer. */
export const IN_APP_PROBE_TIMEOUT_MS = 4_000;

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
 * Reject a promise after `ms` with a clear error. Used for wallet pairing
 * timeouts so the UI shows a useful message instead of hanging forever.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Wait for HashPack's in-app browser to answer the iframe query.
 * DAppConnector discovers the in-app wallet via async postMessage events;
 * this polls its public `extensions` list until an iframe-capable entry
 * appears (or the timeout expires).
 */
async function waitForIframeExtension(
  connector: DAppConnector,
  timeoutMs: number,
): Promise<{ id: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ext = (connector.extensions as { id: string; availableInIframe?: boolean }[]).find(
      (e) => e.availableInIframe,
    );
    if (ext) return { id: ext.id };
    if (Date.now() >= deadline) {
      throw new Error(
        "HashPack did not respond. Make sure you opened this page inside HashPack's built-in browser (tap the globe icon in HashPack), not in Chrome or Safari.",
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
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
  } = await withTimeout(
    import("@hashgraph/hedera-wallet-connect"),
    30_000,
    "Wallet library failed to load. Check your connection and try again.",
  );

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

  // Set the iframe-session callback BEFORE init() in all flows: init()'s
  // internal checkIframeConnect() may fire a pairing request, and the
  // callback must be ready. Harmless in the modal flow.
  //
  // FIX for the hanging "Connecting..." bug (2026-09-11):
  //
  // Root cause was a race condition in DAppConnector.init(). The connector
  // discovers the in-app wallet via async postMessage events
  // ("hedera-iframe-query" → "hedera-iframe-response"), but init()
  // internally calls checkIframeConnect() (fire-and-forget) at the end —
  // if HashPack's response hasn't arrived yet, extensions[] is empty and
  // the pairing silently never starts. The old code then set
  // onSessionIframeCreated AFTER init() returned, waiting on a callback
  // that would never fire.
  //
  // Fix: set the callback BEFORE init(), then after init() explicitly
  // drive the iframe pairing ourselves instead of relying on init()'s
  // internal race-prone call.
  let callbackSession: { namespaces?: Record<string, { accounts?: string[] }> } | null = null;
  let resolveCallback: (s: { namespaces?: Record<string, { accounts?: string[] }> }) => void = () => {};
  const callbackPromise = new Promise<{ namespaces?: Record<string, { accounts?: string[] }> }>(
    (resolve) => {
      resolveCallback = resolve;
    },
  );
  connector.onSessionIframeCreated = (session) => {
    if (!callbackSession) {
      callbackSession = session;
      resolveCallback(session);
    }
  };

  await withTimeout(
    connector.init({ logger: "error" }),
    30_000,
    "Wallet pairing timed out while starting. The WalletConnect relay may be unreachable — check your connection and try again.",
  );

  // init() swallows its own errors internally — verify the client actually
  // came up before proceeding.
  if (!connector.walletConnectClient) {
    throw new Error(
      "Wallet pairing failed to start. The WalletConnect project ID may be invalid or the relay unreachable. Try again or use a different wallet.",
    );
  }

  // Was an iframe wallet already discovered when init() returned? If so,
  // init()'s internal checkIframeConnect() may already have started a
  // pairing request — don't drive a second one.
  const iframeDiscoveredAtInit = connector.extensions.some(
    (ext) => (ext as { availableInIframe?: boolean }).availableInIframe,
  );

  // Choose the pairing channel.
  //
  // Inside a wallet's in-app browser a QR/deep-link pairing modal is
  // useless — it can't be completed from within the wallet app itself (on
  // iPhone it hangs on "Tap 'Open' to continue..."). The pairing happens
  // via the iframe postMessage channel instead.
  //
  // FIX for HashPack iOS (2026-09-11): the synchronous in-app signals
  // (window.hashpack injection, user agent) catch Android and desktop, but
  // HashPack's iOS in-app browser provides NEITHER — sync detection missed
  // it, so the modal flow ran and hung. When sync detection misses, probe
  // the iframe postMessage channel directly (mobile only): the handshake is
  // platform-agnostic — if a wallet answers hedera-iframe-query, we're
  // inside its in-app browser no matter what the UA says. Desktop skips
  // the probe so the modal appears without delay.
  let useIframeFlow = iframeDiscoveredAtInit;
  if (!useIframeFlow) {
    useIframeFlow = await isHashPackInAppBrowserAsync();
  }

  if (useIframeFlow) {
    let session: { namespaces?: Record<string, { accounts?: string[] }> };
    if (iframeDiscoveredAtInit) {
      // init()'s internal checkIframeConnect() already started pairing
      // (the user is seeing the wallet's approval prompt). Just wait for
      // the callback — up to 3 min for approval.
      session = await withTimeout(
        callbackPromise,
        180_000,
        "HashPack did not approve the connection — approve the request in HashPack and try again.",
      );
    } else {
      // The wallet was discovered after init()'s internal check ran —
      // drive connectExtension() explicitly. It sends the pairing string
      // to the parent frame and resolves with the session once the user
      // approves (up to 3 min).
      const extension = await waitForIframeExtension(connector, 15_000);
      const connectPromise = (async () => {
        // connectExtension is public API; it resolves with the session on approval.
        const s = await (
          connector as unknown as {
            connectExtension: (id: string) => Promise<{
              namespaces?: Record<string, { accounts?: string[] }>;
            }>;
          }
        ).connectExtension(extension.id);
        return s;
      })();
      session = await withTimeout(
        Promise.race([callbackPromise, connectPromise]),
        180_000,
        "HashPack did not approve the connection — approve the request in HashPack and try again.",
      );
    }

    const accountId = accountIdFromSession(session);
    if (!accountId) {
      throw new Error("Pairing succeeded but no Hedera account was returned.");
    }
    hcAccountId = accountId;
    return accountId;
  }

  // Standard flow: open the QR pairing modal.
  // Note: if a desktop extension is present, the modal offers it directly.
  // (init() already ran once above — shared by both flows.)
  let session;
  try {
    session = await withTimeout(
      connector.openModal(),
      180_000,
      "The wallet pairing screen timed out. Try again.",
    );
  } catch (modalErr) {
    const msg = modalErr instanceof Error ? modalErr.message : String(modalErr);
    // "Failed to publish custom payload" is a WalletConnect relay rejection —
    // usually an invalid/rate-limited project ID or relay outage. Surface that
    // specifically instead of the generic fallback advice.
    if (/failed to publish/i.test(msg)) {
      throw new Error(
        "The WalletConnect relay rejected the pairing request. This usually means the app's WalletConnect project ID is invalid or rate-limited. Please try again in a minute, or open this page in your wallet's built-in browser instead.",
      );
    }
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

  /* Auto-connect inside a wallet's in-app browser: the wallet is already
     at hand there, so connect on mount instead of making the user tap
     through a wallet picker. Uses async detection so HashPack's iOS
     in-app browser (no sync signal) is covered too; on desktop it
     resolves false immediately. The 7-day session still requires one
     explicit signature (handled by the session layer) — authentication
     is never skipped. Failures surface via wallet.error and the manual
     "Sign in with wallet" picker stays available as a fallback. */
  const autoConnectTried = useRef(false);
  useEffect(() => {
    if (autoConnectTried.current) return;
    if (account) return;
    autoConnectTried.current = true;
    void isHashPackInAppBrowserAsync().then((inApp) => {
      if (!inApp) return;
      return connect("hashpack").catch(() => {
        // connect() already recorded the specific failure in wallet.error
        // and rethrows; swallow the rethrow here since the error state is
        // the user-visible signal.
      });
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
