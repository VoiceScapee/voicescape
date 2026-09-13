"use client";

/**
 * Wallet abstraction for Voicescape.
 *
 * One interface, multiple adapters:
 *  - Hedera (HashPack, Blade, WalletConnect): paired through DAppConnector
 *    from @hashgraph/hedera-wallet-connect (official, HIP-820 based).
 *    Contract calls go through @hiero-ledger/sdk transactions signed in the
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
// entire @hiero-ledger/sdk (~2.3MB) which Vercel's CDN fails to serve reliably
// on mobile ("Loading chunk 3322 failed"). The tx senders are dynamically
// imported only when actually signing a transaction (after wallet connection).
// The @hashgraph/hedera-wallet-connect package is also dynamically imported
// for the same reason + SSR safety.

/**
 * LedgerId comes from the official @hiero-ledger/sdk — loaded via dynamic
 * import (not a static import) so the 2.3MB SDK stays out of the wallet
 * connection chunk that Vercel's CDN must serve on mobile (ChunkLoadError).
 * DAppConnector only calls toString() on the ledger id, and the official
 * class returns "mainnet"/"testnet"/"previewnet" exactly as needed.
 */

export interface WalletState {
  account: string | null;
  chainId: number | null;
  adapterName: string | null;
  isConnecting: boolean;
  error: string | null;
  /**
   * True once the mount-time boot sequence finished (silent restore +
   * optional in-app auto-connect attempt). Lets UIs distinguish "we're
   * still figuring out the wallet" from "nothing is happening" so they
   * never show a fake "Connecting…" state.
   */
  bootSettled: boolean;
  /**
   * True after the user explicitly disconnected. Suppresses any
   * auto-connect UI until the user takes action again.
   */
  userDisconnected: boolean;
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
 * Friendly copy for known transient wallet-library errors.
 *
 * Diagnosis (2026-09-13): no app code invokes `.call()` — the
 * "Cannot read properties of undefined (reading 'call')" TypeError comes
 * from inside @hashgraph/hedera-wallet-connect during provider/signer
 * initialization, and has not been reproduced on the current build. When
 * it does surface, "reading 'call'" is meaningless to a user; map it to
 * the actual recovery step. Unknown errors pass through unchanged.
 */
export function friendlyWalletError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "Failed to connect wallet");
  if (/cannot read propert\w+ of undefined \(reading ['"]call['"]\)/i.test(msg)) {
    return "HashPack didn't finish initializing — reopen or reconnect HashPack, then try again.";
  }
  return msg;
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

/**
 * Pure decision logic for the anonymous in-app-browser header state.
 *
 * Returns:
 * - "connecting" — a real connection attempt is in flight (boot detection
 *   still running, or connect() awaiting the wallet). The ONLY case where
 *   the header may show "Connecting…".
 * - "retry" — boot settled with nothing happening: offer an explicit
 *   one-tap reconnect. Never a fake "Connecting…" here.
 * - "default" — not in the in-app browser, has an account, or an error is
 *   showing: fall through to the normal branches/picker.
 *
 * Extracted pure so the "no unsolicited Connecting…" rule is unit-tested.
 */
export function resolveInAppHeaderState(opts: {
  inHashPackBrowser: boolean;
  account: string | null;
  isConnecting: boolean;
  bootSettled: boolean;
  userDisconnected: boolean;
  error: string | null;
  signInError: string | null;
}): "connecting" | "retry" | "default" {
  const {
    inHashPackBrowser,
    account,
    isConnecting,
    bootSettled,
    userDisconnected,
    error,
    signInError,
  } = opts;
  if (!inHashPackBrowser || account) return "default";
  if (error || signInError) return "default";
  if (userDisconnected) return "retry";
  if (isConnecting || !bootSettled) return "connecting";
  return "retry";
}

/* ------------------------------------------------------------------ */
/* Shared Hedera pairing via DAppConnector                              */
/* ------------------------------------------------------------------ */

/**
 * Module-level DAppConnector singleton — the official recommendation is to
 * "store this instance (e.g. as a singleton) for reuse throughout your
 * application". Module scope survives component unmounts/remounts and
 * Next.js route changes, so the pairing is never rebuilt by navigation.
 *
 * The init-promise guard below prevents the double-init race: React
 * StrictMode double-mounts effects in dev, and the page-load restore can
 * race the in-app-browser auto-connect — all callers share one connector
 * and one init instead of building two and double-prompting the wallet.
 */
let _connector: DAppConnector | null = null;
let _connectorPromise: Promise<DAppConnector> | null = null;
let _initialized = false;
let hcAccountId: string | null = null;
/**
 * Generation counter: every dropConnector() invalidates in-flight builds.
 * If the page-load restore is still importing the wallet library when the
 * user taps "connect", the explicit tap wins and the stale restore build
 * is discarded instead of resurrecting a second connector.
 */
let _generation = 0;

/** React-side listeners for wallet-initiated session loss (see below). */
const pairingLostListeners = new Set<() => void>();

/**
 * Subscribe to wallet-side session loss. When the user disconnects in
 * HashPack (or the session expires), the SignClient fires session_delete /
 * session_expire — the dApp clears its pairing state instantly instead of
 * showing a connected wallet that fails on the next signature.
 * Returns an unsubscribe function.
 */
export function onPairingLost(cb: () => void): () => void {
  pairingLostListeners.add(cb);
  return () => {
    pairingLostListeners.delete(cb);
  };
}

function getPairingProjectId(): string {
  const pid = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  if (!pid) {
    throw new Error(
      "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set. Create a free project at https://cloud.reown.com and add the id to your .env to enable Hedera wallet pairing.",
    );
  }
  return pid;
}

/** Drop the singleton (local state only — no wallet calls). */
function dropConnector(): void {
  _generation++;
  _connector = null;
  _connectorPromise = null;
  _initialized = false;
  hcAccountId = null;
}

async function disconnectHedera(): Promise<void> {
  if (_connector) {
    try {
      await _connector.disconnectAll();
    } catch {
      // Best effort — local state is cleared regardless.
    }
  }
  dropConnector();
}

/**
 * Access the live Hedera pairing for wallet-backed flows that need more
 * than contract calls — e.g. signing x402 payment transactions or direct
 * token transfers. Returns null when no Hedera wallet is paired.
 */
export function getHederaPairing(): { hc: DAppConnector; accountId: string } | null {
  if (!_connector || !hcAccountId) return null;
  return { hc: _connector, accountId: hcAccountId };
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
  const raw = parts[parts.length - 1] || null;
  if (!raw) return null;
  // KISS: Normalize to 0.0.x form. Some wallets return the EVM address
  // (long-zero 0x0000... or alias) instead of the account ID. Convert
  // long-zero back to 0.0.x so the UI always shows the familiar form.
  // Long-zero: 0x00000000000000000000000000000000009f0eff → 0.0.10424063
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    // Check if it's a long-zero address (first 32 chars are zeros)
    if (raw.slice(0, 34) === "0x00000000000000000000000000000000") {
      try {
        const num = BigInt(raw).toString(10);
        return `0.0.${num}`;
      } catch {
        return raw; // Fallback: return as-is if conversion fails
      }
    }
    // It's an alias address (not long-zero) — return as-is, the caller
    // can handle it. We don't try to reverse-resolve aliases here.
    return raw;
  }
  return raw;
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
 * Build (but do not init) a DAppConnector for the active chain. Shared by
 * the fresh-pairing flow and the silent page-load restore — one
 * construction path, one metadata set.
 *
 * Dynamic import keeps the wallet library out of the initial bundle and
 * avoids SSR issues (the package touches browser APIs at import time).
 * NOTE: We deliberately do NOT statically import @hiero-ledger/sdk here — it
 * creates a 2.3MB chunk that Vercel's CDN fails to serve on mobile
 * (ChunkLoadError). LedgerId is dynamically imported from the official SDK
 * below; the full SDK (via ./tx) is only loaded when actually signing a
 * transaction.
 */
async function buildConnector(): Promise<DAppConnector> {
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

  const chain = getActiveChain();
  const isMainnet = chain.key === "hedera-mainnet";
  // Official SDK LedgerId via dynamic import: keeps the SDK out of the
  // wallet connection chunk (see NOTE above). DAppConnector only calls
  // toString() on the ledger id.
  const { LedgerId } = await import("@hiero-ledger/sdk");
  const ledgerId = (isMainnet ? LedgerId.MAINNET : LedgerId.TESTNET) as unknown as never;

  return new DAppConnectorClass(
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
}

/**
 * Module singleton with an init-promise guard: concurrent callers (React
 * StrictMode double-mount, page-load restore racing the in-app-browser
 * auto-connect) share one connector instead of building two and
 * double-prompting the wallet.
 */
async function getConnector(): Promise<DAppConnector> {
  if (_connector) return _connector;
  if (!_connectorPromise) {
    const gen = _generation;
    _connectorPromise = buildConnector().then(
      (c) => {
        // A dropConnector() while the build was in flight means someone
        // else (explicit connect tap) superseded this build — discard it
        // instead of resurrecting a second live connector.
        if (gen !== _generation) throw new Error("connector build superseded");
        _connector = c;
        return c;
      },
      (e) => {
        // Don't cache the failure — a later call retries the build.
        if (gen === _generation) _connectorPromise = null;
        throw e;
      },
    );
  }
  return _connectorPromise;
}

/**
 * Wallet-side disconnects propagate to dApp state instantly: when the user
 * disconnects in HashPack (or the session expires), the SignClient fires
 * session_delete / session_expire — clear the pairing so the UI stops
 * showing a connected wallet that would fail on the next signature.
 * React providers are notified through onPairingLost().
 */
function subscribeSessionEvents(connector: DAppConnector): void {
  const client = connector.walletConnectClient;
  if (!client) return;
  const onSessionGone = () => {
    if (_connector !== connector) return; // stale instance, ignore
    dropConnector();
    for (const cb of pairingLostListeners) {
      try {
        cb();
      } catch {
        /* listener failure must not break other listeners */
      }
    }
  };
  client.on("session_delete", onSessionGone);
  client.on("session_expire", onSessionGone);
}

/**
 * Init the singleton (once) and wire session events. Returns the connector,
 * or null when init failed.
 *
 * Known HashPack bug (#291): init() throws when the user disconnected in
 * the extension, leaving a stale session in localStorage. init() also
 * swallows its own errors internally, so a missing walletConnectClient
 * afterwards means the same thing. Both are treated as "not connected" —
 * never fatal.
 */
async function ensureInitialized(timeoutMessage: string): Promise<DAppConnector | null> {
  const connector = await getConnector();
  if (_initialized) return connector;
  try {
    await withTimeout(connector.init({ logger: "error" }), 30_000, timeoutMessage);
  } catch {
    dropConnector();
    return null;
  }
  // init() swallows its own errors internally — verify the client actually
  // came up before proceeding.
  if (!connector.walletConnectClient) {
    dropConnector();
    return null;
  }
  subscribeSessionEvents(connector);
  _initialized = true;
  return connector;
}

/**
 * Silently restore a previously-approved Hedera pairing after a page
 * reload. WalletConnect's SignClient persists sessions in localStorage, so
 * init() rehydrates them into `connector.signers` — no re-prompt, no
 * openModal() needed when a live session exists.
 *
 * Returns the account id when a usable pairing was restored, null
 * otherwise. Never throws: a failed restore just means the user connects
 * manually (or via the in-app-browser auto-connect).
 */
export async function restoreHederaPairing(): Promise<string | null> {
  try {
    if (_connector && hcAccountId) return hcAccountId; // already live
    const connector = await ensureInitialized("Wallet restore timed out.");
    // The restore may have been superseded by an explicit connect tap
    // while init was in flight — only adopt the pairing when this
    // connector is still the live singleton.
    if (!connector || _connector !== connector) return null;
    const signer = connector.signers?.[0];
    const accountId = signer?.getAccountId?.()?.toString?.() ?? null;
    if (!accountId || !/^0\.0\.\d+$/.test(accountId)) return null;
    hcAccountId = accountId;
    return accountId;
  } catch {
    // Stale storage / relay unreachable / HashPack #291: not connected.
    return null;
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
  // Explicit user connect = fresh pairing. Drop any existing connector
  // first (silent restore is for page-load only, never for a tap).
  await disconnectHedera();

  const connector = await getConnector();

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

  await ensureInitialized(
    "Wallet pairing timed out while starting. The WalletConnect relay may be unreachable — check your connection and try again.",
  );

  // ensureInitialized() returns null when init failed (HashPack #291,
  // unreachable relay, stale storage) — surface the actionable error.
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
    if (!_connector || !hcAccountId) {
      throw new Error("Hedera wallet is not connected.");
    }
    // Dynamic import: ./tx pulls in @hiero-ledger/sdk (~2.3MB). Only load it
    // when actually signing — never on page load or wallet connection.
    const { createHederaTxSender } = await import("./tx");
    return createHederaTxSender(_connector, hcAccountId, chain);
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
      // Dynamic import keeps @hiero-ledger/sdk out of the initial bundle.
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

/** localStorage key remembering which adapter last paired (HashPack/Blade/WC). */
const ADAPTER_STORAGE_KEY = "vs-wallet-adapter-v1";

/**
 * Which adapter created the current pairing, if known. Read on page load
 * so a restored pairing shows the right wallet label.
 */
export function readStoredAdapterId(): WalletAdapterId | null {
  try {
    const raw = window.localStorage.getItem(ADAPTER_STORAGE_KEY);
    return raw && WALLET_ADAPTERS.some((a) => a.id === raw) ? (raw as WalletAdapterId) : null;
  } catch {
    return null;
  }
}

export function writeStoredAdapterId(id: WalletAdapterId | null): void {
  try {
    if (id) window.localStorage.setItem(ADAPTER_STORAGE_KEY, id);
    else window.localStorage.removeItem(ADAPTER_STORAGE_KEY);
  } catch {
    /* storage unavailable — the adapter just won't persist */
  }
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [adapterName, setAdapterName] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bootSettled, setBootSettled] = useState(false);
  const [userDisconnected, setUserDisconnected] = useState(false);
  const senderGetter = React.useRef<(() => Promise<TxSender>) | null>(null);

  const connect = useCallback(async (adapterId: WalletAdapterId) => {
    setIsConnecting(true);
    setError(null);
    setUserDisconnected(false);
    try {
      const chain = getActiveChain();
      const adapter = ADAPTERS[adapterId];
      const result = await adapter.connect(chain);
      senderGetter.current = result.getTxSender;
      setAccount(result.account);
      setChainId(result.chainId);
      setAdapterName(adapterId);
      // Remember which adapter paired, so a page reload can restore the
      // same pairing silently (and show the right wallet label).
      writeStoredAdapterId(adapterId);
      return result.account;
    } catch (e) {
      senderGetter.current = null;
      // Map known transient wallet-library TypeErrors (e.g. the
      // hedera-wallet-connect "reading 'call'" init race) to actionable
      // copy; everything else passes through unchanged.
      const msg = friendlyWalletError(e);
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
    setUserDisconnected(true);
    writeStoredAdapterId(null);
  }, [adapterName]);

  /* Wallet-side session loss (session_delete / session_expire from
     HashPack): clear React state instantly so the UI stops showing a
     connected wallet. The 7-day sign-in session (layer b) is untouched —
     it stays valid for API calls; only the live pairing is gone. */
  useEffect(() => {
    return onPairingLost(() => {
      senderGetter.current = null;
      setAccount(null);
      setChainId(null);
      setAdapterName(null);
    });
  }, []);

  /* Boot on mount — restore first, pair only when needed:
     1. Silently restore a previously-approved pairing. WalletConnect
        persists sessions in localStorage, so a page reload must NOT force
        a reconnect: init() rehydrates the session with no user gesture.
     2. Only when nothing is restorable AND we're inside a wallet's in-app
        browser (HashPack), pair immediately — the wallet is one tap away
        there, so auto-connect instead of showing the picker. Everywhere
        else the manual picker stays the entry point.
     Runs once per mount. The root provider never remounts on SPA
     navigation, so this can't loop; the init-promise guard covers
     StrictMode double-mount in dev. */
  const bootTried = useRef(false);
  useEffect(() => {
    if (bootTried.current) return;
    if (account) return;
    bootTried.current = true;
    (async () => {
      try {
        setIsConnecting(true);
        try {
          const restoredAccount = await restoreHederaPairing();
          const pairing = getHederaPairing();
          if (restoredAccount && pairing) {
            const chain = getActiveChain();
            senderGetter.current = hederaGetTxSender(chain);
            setAccount(pairing.accountId);
            setChainId(chain.chainId);
            setAdapterName(readStoredAdapterId() ?? "hashpack");
            return;
          }
        } catch {
          /* restore failed — fall through to the flows below */
        } finally {
          setIsConnecting(false);
        }
        const inApp = await isHashPackInAppBrowserAsync().catch(() => false);
        if (inApp) {
          // Await the attempt (not fire-and-forget) so bootSettled only
          // flips once the auto-connect resolved or failed — the header
          // "Connecting…" state below is then always backed by real activity.
          await connect("hashpack").catch(() => {
            // connect() already recorded the specific failure in
            // wallet.error and rethrows; swallow it here since the error
            // state is the user-visible signal and the manual picker
            // remains as a fallback.
          });
        }
      } finally {
        setBootSettled(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect]);

  const getTxSender = useCallback(async (): Promise<TxSender> => {
    if (!senderGetter.current) throw new Error("Connect a wallet first.");
    return senderGetter.current();
  }, []);

  const value = useMemo<WalletState>(
    () => ({ account, chainId, adapterName, isConnecting, error, bootSettled, userDisconnected, connect, disconnect, getTxSender }),
    [account, chainId, adapterName, isConnecting, error, bootSettled, userDisconnected, connect, disconnect, getTxSender],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
