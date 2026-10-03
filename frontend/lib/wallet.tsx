"use client";

/**
 * Wallet abstraction for Voicescape.
 *
 * One interface, multiple adapters:
 *  - Hedera (HashPack, Blade, WalletConnect): paired through DAppConnector
 *    from @hashgraph/hedera-wallet-connect (official, HIP-820 based).
 *    Contract calls go through @hiero-ledger/sdk transactions signed in the
 *    wallet — see lib/tx.ts.
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
import type { DAppConnector } from "@hashgraph/hedera-wallet-connect";
import { getActiveChain, type ChainConfig } from "./chains";
import type { TxSender } from "./tx";
import { reportError } from "./report-error";
import { recordConversionEvent } from "./metrics";
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
 * class returns "mainnet" exactly as needed (mainnet only — no testnet).
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
   * Result of the async in-app-browser probe (isHashPackInAppBrowserAsync),
   * run once at boot. Null while the probe is still running. This is the
   * single source of truth both boot and the header consume — the SYNC
   * isHashPackInAppBrowser() returns false inside HashPack's iOS in-app
   * browser (no injection, no UA signal), so the header must not rely on
   * it or iOS users get the dead-end QR picker.
   */
  inAppBrowser: boolean | null;
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

export type WalletAdapterId = "hashpack" | "blade" | "walletconnect";

export const WALLET_ADAPTERS: { id: WalletAdapterId; name: string; chains: string[] }[] = [
  { id: "hashpack", name: "HashPack", chains: ["hedera-mainnet"] },
  { id: "blade", name: "Blade", chains: ["hedera-mainnet"] },
  { id: "walletconnect", name: "WalletConnect", chains: ["hedera-mainnet"] },
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
  /**
   * window.self !== window.top — the page is running inside an iframe.
   * On a phone this is a strong wallet-container signal: HashPack's
   * Android dApp browser iframes the page without injecting
   * window.hashpack or setting a "hashpack" user agent, so without this
   * signal detection misses it and the deep-link modal runs as a
   * guaranteed dead end (self-pairing). Desktop iframes are just embeds,
   * never wallet containers, so this signal only counts on mobile.
   */
  isIframed?: boolean;
  isMobile?: boolean;
}): boolean {
  if (signals.hasInjectedHashpack) return true;
  if (/hashpack/i.test(signals.userAgent)) return true;
  if (signals.isMobile && signals.isIframed) return true;
  return false;
}

/**
 * True when the page is running inside HashPack's in-app browser (or the
 * HashPack extension has injected its provider). Signals, in order:
 * window.hashpack injection, a "hashpack" user agent, and — on mobile
 * only — running inside an iframe (HashPack's Android dApp browser
 * iframes the page with neither injection nor UA signal). In that
 * environment the wallet is one tap away — the QR pairing modal is never
 * useful, and the app auto-connects on mount instead of waiting for the
 * user to pick a wallet.
 *
 * NOTE: HashPack's iOS in-app browser provides NONE of the sync signals
 * (no `window.hashpack` injection, no "hashpack" in the WKWebView user
 * agent, and the iframing behavior is unverified there), so this still
 * returns false there. Use `isHashPackInAppBrowserAsync()` when you need
 * a reliable answer on iOS.
 */
export function isHashPackInAppBrowser(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { hashpack?: unknown };
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  // Comparing window.self to window.top is safe cross-origin (no property
  // access on the foreign frame); only property reads would throw.
  let isIframed = false;
  try {
    isIframed = window.self !== window.top;
  } catch {
    isIframed = false;
  }
  return detectHashPackInAppBrowser({
    hasInjectedHashpack: w.hashpack !== undefined && w.hashpack !== null,
    userAgent: ua,
    isIframed,
    isMobile: isMobileUserAgent(ua),
  });
}

/**
 * Signals used to detect a wallet browser extension's injected provider.
 * Pure function of its inputs so it can be unit-tested without a DOM.
 */
export function detectInjectedHederaWallet(signals: {
  hashpack?: unknown;
  blade?: unknown;
}): boolean {
  return signals.hashpack != null || signals.blade != null;
}

/**
 * True when a Hedera wallet extension has injected its provider into this
 * page (HashPack exposes `window.hashpack`; Blade exposes `window.blade`).
 * Used for the desktop no-wallet pre-flight: with no injected provider and
 * no in-app browser, the QR pairing modal is a dead end, so the picker
 * shows install guidance instead of opening it. Mobile is exempt — the
 * modal deep-links straight into the wallet app there, no extension needed.
 */
export function hasInjectedHederaWallet(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { hashpack?: unknown; blade?: unknown };
  return detectInjectedHederaWallet({ hashpack: w.hashpack, blade: w.blade });
}

/**
 * Pure decision logic for the desktop no-wallet pre-flight. Returns true
 * when opening the QR pairing modal would be a dead end: a desktop
 * browser, not inside a wallet's in-app browser, and no wallet extension
 * injected — every picker option funnels into the same modal and it would
 * wait forever. Mobile is exempt: the modal deep-links straight into the
 * wallet app there, no extension needed.
 *
 * Extracted pure so the "no dead-end modal" rule is unit-tested.
 */
export function shouldSuggestWalletInstall(opts: {
  isMobile: boolean;
  inHashPackBrowser: boolean;
  hasInjectedWallet: boolean;
}): boolean {
  return !opts.isMobile && !opts.inHashPackBrowser && !opts.hasInjectedWallet;
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
 * Posts `hedera-iframe-query` to both the page's own window and the
 * parent frame, and waits for a `hedera-iframe-response` — the same
 * handshake DAppConnector uses for in-app discovery, so it's
 * platform-agnostic: it works in HashPack's iOS in-app browser, which
 * provides no `window.hashpack` injection or UA signal. Resolves true
 * when a wallet answers, false on timeout. Never rejects.
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
      // The wallet's in-app container may listen on the page's own window
      // (injected bridge — this is how HashPack's Android dApp browser
      // answers) or on the parent frame (the wallet library's own
      // extensionQuery() posts the iframe query to window.parent). Ask
      // BOTH: our listener only reacts to hedera-iframe-response, so the
      // self-post is harmless. Posting only to window.parent missed
      // HashPack Android entirely — the page hung on the pairing screen
      // until the modal timeout (2026-10-03 pilot recording).
      window.postMessage({ type: "hedera-iframe-query" }, "*");
      window.parent.postMessage({ type: "hedera-iframe-query" }, "*");
    } catch {
      cleanup();
      resolve(false);
    }
  });
}

/**
 * Thrown when the user closes the WalletConnect pairing modal themselves
 * (X / Escape / click-outside) before approving. A deliberate cancel, not
 * a failure — callers must reset quietly: no error banner, no failure
 * telemetry. The button simply returns to "Connect".
 */
export class PairingCancelledError extends Error {
  constructor() {
    super("Pairing cancelled");
    this.name = "PairingCancelledError";
  }
}

/**
 * True when an error means the user dismissed the pairing modal
 * themselves — either the library's "User rejected pairing" (thrown when
 * openModal() is called with throwErrorOnReject=true and the modal closes)
 * or our own PairingCancelledError. Never true for real failures.
 */
export function isPairingCancelled(e: unknown): boolean {
  if (e instanceof PairingCancelledError) return true;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /user rejected pairing/i.test(msg);
}

/**
 * Human fallback when a wallet call rejects with something that carries
 * no usable message. Never String() an unknown object here — that
 * renders as "[object Object]" in the UI (pilot recording, 2026-10-03).
 */
const WALLET_ERROR_FALLBACK = "Couldn't connect to your wallet — please try again.";

/**
 * Extract a human-readable message from anything a wallet call can
 * reject with. WalletConnect's SignClient rejects with PLAIN OBJECTS
 * ({code, message}), not Errors — e.g. when a pairing dies while
 * approval() pends. Prefer a real message field; never leak the object
 * form to the user.
 */
function walletRejectionMessage(e: unknown): string {
  if (e instanceof Error) return e.message || WALLET_ERROR_FALLBACK;
  if (typeof e === "string") return e || WALLET_ERROR_FALLBACK;
  if (e !== null && typeof e === "object") {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m;
  }
  return WALLET_ERROR_FALLBACK;
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
  const msg = walletRejectionMessage(e);
  // A dismissed pairing modal is a deliberate cancel, not a declined
  // transaction — keep it calm and specific, and check BEFORE the generic
  // "user rejected" mapping below (which talks about transactions).
  if (isPairingCancelled(e)) {
    return "Connection closed before your wallet approved it — try again when you're ready.";
  }
  if (/cannot read propert\w+ of undefined \(reading ['"]call['"]\)/i.test(msg)) {
    return "HashPack didn't finish initializing — reopen or reconnect HashPack, then try again.";
  }
  // WalletConnect wraps Hedera precheck failures as error 9000 with the
  // ResponseCodeEnum name in the message. Map the common ones to human
  // copy instead of leaking raw status text to a phone user mid-tip.
  if (/INSUFFICIENT_PAYER_BALANCE/i.test(msg)) {
    return "Not enough HBAR in your wallet to cover this transaction (including network fees).";
  }
  if (/INSUFFICIENT_TX_FEE/i.test(msg)) {
    return "The transaction fee was too low to be accepted — try again.";
  }
  if (/TRANSACTION_EXPIRED/i.test(msg)) {
    return "The transaction expired before it could be submitted — try again.";
  }
  if (/DUPLICATE_TRANSACTION/i.test(msg)) {
    return "This transaction was already submitted — check HashScan before retrying.";
  }
  if (/INVALID_SIGNATURE|INVALID_PAYER_SIGNATURE/i.test(msg)) {
    return "The wallet's signature was rejected — reconnect your wallet and try again.";
  }
  // User rejection surfaces variously ("rejected", "declined", "cancelled",
  // WalletConnect 4001).
  if (/\b(4001|user rejected|request rejected|transaction (was )?rejected|declined|cancelled|canceled)\b/i.test(msg)) {
    return "You declined the transaction in your wallet — nothing was sent.";
  }
  return msg;
}

/**
 * Single source of truth for the stale-connection guidance. Shown when a
 * WalletConnect session goes silent (the wallet never answers) — the fix
 * is a fresh pairing, not retrying the same action.
 */
export const STALE_CONNECTION_COPY =
  "HashPack didn't respond — the wallet connection went stale. " +
  "Reconnect your wallet and try again.";

/**
 * Event the in-chat one-tap approval card dispatches when the pairing is
 * missing or stale and the agent can't fix it itself. The chat widget
 * mounts outside the wallet provider, so it can't call connect()
 * directly — the nearest mounted WalletConnect component hears this and
 * opens its pairing UI. One tap in the chat opens the standard flow the
 * user already knows; the user then taps Approve again deliberately.
 */
export const OPEN_WALLET_CONNECT_EVENT = "vs:open-wallet-connect";

/** Dispatch the wallet-connect UI event; no-ops when nothing is listening. */
export function requestWalletConnectUI(): void {
  try {
    window.dispatchEvent(new CustomEvent(OPEN_WALLET_CONNECT_EVENT));
  } catch {
    /* no UI mounted — the card's copy still guides the user */
  }
}

/**
 * True when a wallet error message means the WalletConnect session went
 * stale — the wallet never responded, so the fix is a fresh pairing, not
 * retrying the same action. Single source of truth for the tip modal's
 * repair button and the session sign-in handler.
 */
export function isStaleConnectionError(message: string | null | undefined): boolean {
  return /stale|didn't respond/i.test(message ?? "");
}

/**
 * One-tap stale-session repair: clear the dead session (which also
 * disconnects the wallet) and start a fresh pairing with the given
 * adapter. Resolves on success; throws the friendly connect() error on
 * failure. Callers show the error and must NOT auto-retry the payment —
 * the user re-taps deliberately once the connection is healthy.
 */
export async function repairStaleConnection(deps: {
  signOut: () => void;
  connect: (adapterId: WalletAdapterId) => Promise<unknown>;
  adapterId: WalletAdapterId;
}): Promise<void> {
  deps.signOut();
  await deps.connect(deps.adapterId);
}

/** How long the proactive session-liveness probe waits for a wallet answer. */
export const WALLET_LIVENESS_TIMEOUT_MS = 10_000;

/** Upper bound for the one-shot re-wake attempt after a failed liveness probe. */
export const REWAKE_TIMEOUT_MS = 12_000;
/**
 * Liveness-probe budget for the post-re-wake recheck. Shorter than the
 * first probe — the relay socket was just reconnected, so a healthy
 * session answers fast; a slow one is genuinely dying.
 */
export const REWAKE_PROBE_TIMEOUT_MS = 8_000;

/**
 * Testable core of the liveness probe: asks the wallet for the paired
 * account's balance through the live DAppConnector session. A balance
 * query is read-only — wallets answer it silently, never with a prompt —
 * so this proves the session can actually talk to the wallet right now.
 * The balance itself is discarded: never logged, never stored, never
 * returned.
 *
 * Resolves false (never throws) when there is no signer, the query hangs
 * past the timeout, or the wallet answers with an error — in every one of
 * those cases the pairing could not sign a transaction either.
 */
export async function __probePairingLiveness(
  pairing: { hc: DAppConnector; accountId: string },
  timeoutMs: number = WALLET_LIVENESS_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const signers = pairing.hc.signers ?? [];
    const signer =
      signers.find((s) => {
        try {
          return s.getAccountId().toString() === pairing.accountId;
        } catch {
          return false;
        }
      }) ?? signers[0];
    if (!signer) return false;
    await withTimeout(signer.getAccountBalance(), timeoutMs, "wallet liveness probe timed out");
    return true;
  } catch {
    return false;
  }
}

/**
 * Proactive wallet-session liveness check for pre-flight guards (e.g. the
 * tip modal). Returns true only when the current pairing provably answered
 * a read-only query through the live session; false when there is no
 * pairing OR the probe failed — callers must only claim "stale" when a
 * pairing existed and the probe failed, never from a bare false here.
 * Never throws.
 */
export async function isWalletSessionAlive(
  timeoutMs: number = WALLET_LIVENESS_TIMEOUT_MS,
): Promise<boolean> {
  const pairing = getHederaPairing();
  if (!pairing) return false;
  return __probePairingLiveness(pairing, timeoutMs);
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
/** Full HIP-30 session account ("hedera:<network>:<account>") for change detection. */
let hcSessionAccount: string | null = null;
/**
 * Generation counter: every dropConnector() invalidates in-flight builds.
 * If the page-load restore is still importing the wallet library when the
 * user taps "connect", the explicit tap wins and the stale restore build
 * is discarded instead of resurrecting a second connector.
 */
let _generation = 0;

/** React-side listeners for wallet-initiated session loss (see below). */
const pairingLostListeners = new Set<() => void>();
/** Fired when the wallet switches to a different account mid-session. */
const accountChangedListeners = new Set<(newAccount: string) => void>();

/**
 * Subscribe to wallet-side account switches. When the user changes accounts
 * in HashPack (or any HIP-820 wallet), the SignClient fires session_update
 * with the new account list. The dApp's pairing and 7-day sign-in session
 * are both bound to the OLD address, so the only safe move is to drop the
 * pairing and have the user reconnect — otherwise the UI would show one
 * account while the wallet signs as another.
 * Returns an unsubscribe function.
 */
export function onAccountChanged(cb: (newAccount: string) => void): () => void {
  accountChangedListeners.add(cb);
  return () => {
    accountChangedListeners.delete(cb);
  };
}

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
  hcSessionAccount = null;
  // Every DAppConnector build appends a fresh `wcm-modal` element to
  // document.body (the library's initUi is not idempotent), so rebuilding
  // the connector — e.g. on every explicit connect tap — leaked modal
  // instances: two stacked "Connect your wallet" modals ended up in the
  // accessibility tree and the stale one obscured the live modal's X
  // button. Remove them here so at most one modal element ever exists.
  if (typeof document !== "undefined") {
    document.querySelectorAll("wcm-modal").forEach((el) => el.remove());
  }
}

/** Record the pairing's full HIP-30 identity for change detection. */
function trackSessionAccount(session: { namespaces?: Record<string, { accounts?: string[] }> }): void {
  hcSessionAccount = rawSessionAccount(session);
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
 * Best-effort cleanup of stale WalletConnect *sessions* after a fresh
 * pairing succeeds — preserves the old "fresh pairing" intent surgically,
 * without the pairing-murder side effect. Disconnects every session
 * EXCEPT the newly approved one (matched by topic). Pending *pairings*
 * are NEVER touched: deleting a pairing kills the wallet's approval
 * sheet mid-flight ("Pair with dApp" vanishing before the user can
 * approve). If the new session's topic is unknown, does nothing rather
 * than risk disconnecting the just-approved session.
 *
 * Exported (no DOM) so the sessions-only cleanup contract is unit-tested.
 */
export async function disconnectStaleSessions(
  connector: DAppConnector,
  keepTopic: string | null,
): Promise<void> {
  if (!keepTopic) return;
  try {
    const client = connector.walletConnectClient;
    if (!client) return;
    const sessions = client.session.getAll() ?? [];
    for (const s of sessions) {
      if (s.topic && s.topic !== keepTopic) {
        try {
          await connector.disconnect(s.topic);
        } catch {
          /* best effort — the new pairing already succeeded */
        }
      }
    }
  } catch {
    /* best effort — never fail a successful pairing over cleanup */
  }
}

/** Topic of an approved WalletConnect session struct, or null if unknown. Exported for tests. */
export function sessionTopic(session: unknown): string | null {
  if (session !== null && typeof session === "object") {
    const t = (session as { topic?: unknown }).topic;
    if (typeof t === "string" && t) return t;
  }
  return null;
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
 * "hedera-mainnet" → "mainnet". Matches the network segment in WalletConnect
 * HIP-30 account strings ("hedera:mainnet:0.0.12345").
 */
export function networkFromChainKey(key: string): string {
  return key.replace(/^hedera-/, "");
}

/** Raw first HIP-30 account string from a session ("hedera:<network>:<account>"). */
function rawSessionAccount(session: {
  namespaces?: Record<string, { accounts?: string[] }>;
}): string | null {
  const accounts = session.namespaces?.hedera?.accounts;
  return accounts && accounts.length > 0 ? accounts[0] : null;
}

/**
 * Extract the account ID from a WalletConnect session.
 * Session accounts look like "hedera:mainnet:0.0.12345" (HIP-30 format).
 *
 * When `expectedNetwork` is given ("mainnet"), the session's network is
 * validated against it and a mismatch throws a user-actionable error.
 * Without this check a wallet sitting on the wrong network would pair as
 * if it were on mainnet — every subsequent transaction would be built for
 * the wrong network.
 */
export function accountIdFromSession(
  session: { namespaces?: Record<string, { accounts?: string[] }> },
  expectedNetwork?: string,
): string | null {
  const accounts = session.namespaces?.hedera?.accounts;
  if (!accounts || accounts.length === 0) return null;
  // Format: "hedera:<network>:<accountId>" → take the last part
  const parts = accounts[0].split(":");
  if (expectedNetwork && parts.length >= 3) {
    const sessionNetwork = parts[1].toLowerCase();
    if (sessionNetwork !== expectedNetwork.toLowerCase()) {
      throw new Error(
        `Your wallet is on Hedera ${sessionNetwork}, but this app uses Hedera ${expectedNetwork}. Switch networks in your wallet and connect again.`,
      );
    }
  }
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
      throw new Error(IN_APP_HANDSHAKE_FAILED_COPY);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Shown when the page is inside a wallet's in-app browser (or iframed on
 * a phone) but the wallet's built-in connector never answered the iframe
 * handshake. Fail fast with plain words — NEVER fall through to the
 * WalletConnect deep-link modal here: inside the wallet app the wc: link
 * is intercepted by the host wallet itself (self-pairing can never
 * complete), so the modal would just hang until its timeout.
 */
export const IN_APP_HANDSHAKE_FAILED_COPY =
  "We couldn't reach HashPack's built-in connector. Close this page and reopen it from HashPack's dApp browser (the globe icon), then try again — or open this page in your phone's regular browser and use the WalletConnect option there.";

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

  // Mainnet only — no testnet (Brandon's rule 2026-09-28). The wallet can
  // only pair on Hedera mainnet.
  // Official SDK LedgerId via dynamic import: keeps the SDK out of the
  // wallet connection chunk (see NOTE above). DAppConnector only calls
  // toString() on the ledger id. Bounded like the wallet-library import
  // above — an unbounded import here used to hang the page-load restore
  // forever with the header stuck on "Connecting…".
  const { LedgerId } = await withTimeout(
    import("@hiero-ledger/sdk"),
    30_000,
    "Wallet library failed to load. Check your connection and try again.",
  );
  const ledgerId = LedgerId.MAINNET as unknown as never;

  return new DAppConnectorClass(
    {
      name: "Voicescape",
      description: "Blockpages for humans and AI agents, with on-chain tipping",
      url: window.location.origin,
      icons: [`${window.location.origin}/icon.svg`],
    },
    ledgerId,
    getPairingProjectId(),
    Object.values(HederaJsonRpcMethod),
    [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
    [HederaChainId.Mainnet],
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
  // Account OR network switch in the wallet: drop the pairing (it's bound to
  // the old address/network) and let listeners show a "reconnect" message.
  // Compares the full "hedera:<network>:<account>" string so a network
  // switch with the same account number is also caught.
  client.on("session_update", ({ params }: { params?: { namespaces?: Record<string, { accounts?: string[] }> } }) => {
    if (_connector !== connector || !hcSessionAccount) return; // stale instance or not paired
    const next = rawSessionAccount({ namespaces: params?.namespaces });
    if (next && next !== hcSessionAccount) {
      const newAccount = accountIdFromSession({ namespaces: params?.namespaces });
      dropConnector();
      for (const cb of accountChangedListeners) {
        try {
          cb(newAccount ?? next);
        } catch {
          /* listener failure must not break other listeners */
        }
      }
    }
  });
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
    // No session object here (signer-derived) — reconstruct the HIP-30
    // identity from the active chain for change detection.
    hcSessionAccount = `hedera:${networkFromChainKey(getActiveChain().key)}:${accountId}`;
    return accountId;
  } catch {
    // Stale storage / relay unreachable / HashPack #291: not connected.
    return null;
  }
}

/**
 * Re-wake a pairing whose liveness probe just failed — no user action.
 *
 * Mobile browsers suspend background tabs: after an app-switch pairing
 * (wallet app → back to the browser) the WalletConnect relay socket is
 * often dead even though the session itself is persisted and healthy.
 * Dropping the connector singleton and rebuilding rehydrates the
 * persisted session from localStorage and reconnects the relay — exactly
 * what a page reload does, without the reload.
 *
 * Returns the fresh pairing, or null when the session is truly gone (or
 * the rebuild timed out). Never throws — callers fall through to the
 * normal stale-pairing path with its one-tap reconnect. Deps are
 * injectable for tests; production callers pass none.
 */
export async function rewakeHederaPairing(
  deps: {
    drop?: () => void;
    restore?: () => Promise<string | null>;
    read?: () => { hc: DAppConnector; accountId: string } | null;
    timeoutMs?: number;
  } = {},
): Promise<{
  hc: DAppConnector;
  accountId: string;
} | null> {
  const drop = deps.drop ?? dropConnector;
  const restore = deps.restore ?? restoreHederaPairing;
  const read = deps.read ?? getHederaPairing;
  const timeoutMs = deps.timeoutMs ?? REWAKE_TIMEOUT_MS;
  try {
    drop();
    const accountId = await withTimeout(restore(), timeoutMs, "wallet re-wake timed out");
    if (!accountId) return null;
    return read();
  } catch {
    return null;
  }
}

/**
 * How long the QR pairing modal waits for the wallet to approve before
 * giving up with a visible error. Two minutes: enough to grab your phone,
 * scan, and approve — short enough that nobody stares at a silent spinner.
 */
export const MODAL_PAIRING_TIMEOUT_MS = 120_000;

/**
 * Open the WalletConnect QR pairing modal and wait for approval.
 *
 * Two fixes over the old bare `connector.openModal()` call:
 *
 * 1. throwErrorOnReject=true: closing the modal (X / Escape / click-outside)
 *    now rejects immediately with "User rejected pairing" instead of
 *    hanging until the timeout — the old behavior left the header stuck on
 *    "Connecting…" for up to 3 minutes after the user dismissed the modal.
 *    Callers translate that into a quiet cancel via isPairingCancelled().
 * 2. On timeout the modal is closed programmatically, so the user actually
 *    sees the error + retry UI instead of a dead modal sitting open.
 */
async function openPairingModal(
  connector: DAppConnector,
): Promise<Awaited<ReturnType<DAppConnector["openModal"]>>> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      connector.walletConnectModal.closeModal();
    } catch {
      /* best effort — the timeout error below is what matters */
    }
  }, MODAL_PAIRING_TIMEOUT_MS);
  try {
    return await connector.openModal(undefined, true);
  } catch (e) {
    if (timedOut) {
      throw new Error(
        "No wallet approved the connection in time. Keep your wallet open and nearby, then try again.",
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pairing channels for connectHederaWallet().
 */
export type PairingChannel = "iframe" | "modal";

/**
 * Pure routing decision for wallet pairing. Extracted so the
 * "never-modal-inside-a-wallet-app" invariant is unit-tested.
 *
 * - "iframe": an in-app wallet was discovered (the library's init-time
 *   iframe discovery, or ANY in-app signal fired — injection, UA,
 *   iframed-on-mobile, or the iframe-channel probe). Pair via the iframe
 *   postMessage channel. The WalletConnect deep-link modal is NEVER used
 *   here: inside a wallet app the wc: link is intercepted by the host
 *   wallet itself — self-pairing can never complete, and the user hangs
 *   until the modal timeout (pilot recording, 2026-10-03).
 * - "modal": standard WalletConnect QR/deep-link modal — desktop, or an
 *   external mobile browser where the modal deep-links into the wallet
 *   app (that path works).
 */
export function decidePairingChannel(opts: {
  iframeDiscoveredAtInit: boolean;
  inAppDetected: boolean;
}): PairingChannel {
  return opts.iframeDiscoveredAtInit || opts.inAppDetected ? "iframe" : "modal";
}

/**
 * Last line of defense, shown if the deep-link pairing modal was about
 * to open from inside a wallet's in-app browser. Unreachable in the
 * normal flow — the channel choice above routes in-app users to the
 * iframe channel — it exists so a future detection regression can never
 * silently resurrect the self-pairing dead end.
 */
export const IN_APP_MODAL_BLOCKED_COPY =
  "You're already inside a wallet's built-in browser, so the pairing screen can't open here. Close this page and reopen it from the wallet's dApp browser (the globe icon), then connect again.";

/**
 * Pair a Hedera wallet through DAppConnector (@hashgraph/hedera-wallet-connect).
 *
 * Flow: construct DAppConnector with dapp metadata + ledger id + WalletConnect
 * project id, init(), then openModal() for QR-based pairing with any HIP-820
 * wallet (HashPack mobile, Blade, Kabila…). Inside HashPack's in-app browser
 * the pairing happens via the iframe callback instead of a QR modal.
 */
async function connectHederaWallet(chain: ChainConfig): Promise<string> {
  // Explicit user connect = fresh pairing intent. Drop the LOCAL
  // connector state only — NEVER delete relay pairings here.
  //
  // Pairing-murder fix (2026-10-03): this used to call disconnectHedera(),
  // whose disconnectAll() deletes live WalletConnect pairings on the
  // relay. Any second trigger (double-tap, impatient re-tap, boot
  // auto-connect racing a manual tap) deleted the pending proposal out
  // from under the wallet — HashPack's "Pair with dApp" sheet vanished
  // before the user could approve, indistinguishable from "the wallet
  // auto-canceled". Relay state is now left untouched: a pending proposal
  // survives a failed/retried attempt, and an approval that lands late
  // still reaches the session store for restore to pick up.
  dropConnector();

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
  // iPhone it hangs on "Tap 'Open' to continue..."; on Android the wc:
  // link is intercepted by the host wallet and the self-pairing sheet
  // flashes and vanishes). The pairing happens via the iframe postMessage
  // channel instead.
  //
  // FIX for HashPack iOS (2026-09-11): the synchronous in-app signals
  // (window.hashpack injection, user agent) catch Android and desktop, but
  // HashPack's iOS in-app browser provides NEITHER — sync detection missed
  // it, so the modal flow ran and hung. When sync detection misses, probe
  // the iframe postMessage channel directly (mobile only): the handshake is
  // platform-agnostic — if a wallet answers hedera-iframe-query, we're
  // inside its in-app browser no matter what the UA says. Desktop skips
  // the probe so the modal appears without delay.
  //
  // FIX for HashPack Android (2026-10-03): the dApp browser iframes the
  // page with no injection and no hashpack UA, and our probe only asked
  // window.parent — every signal missed, so the modal ran as a guaranteed
  // dead end. Detection is now redundant (injection + UA + iframed-on-
  // mobile + probe to both window and window.parent), and the routing
  // below NEVER opens the modal when any in-app signal fires.
  let useIframeFlow = iframeDiscoveredAtInit;
  if (!useIframeFlow) {
    useIframeFlow = await isHashPackInAppBrowserAsync();
  }

  if (decidePairingChannel({ iframeDiscoveredAtInit, inAppDetected: useIframeFlow }) === "iframe") {
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

    const accountId = accountIdFromSession(session, networkFromChainKey(chain.key));
    if (!accountId) {
      throw new Error("Pairing succeeded but no Hedera account was returned.");
    }
    hcAccountId = accountId;
    // Fresh-pairing hygiene, surgically: drop stale sessions from earlier
    // pairings now that the new one succeeded — sessions only, never
    // pending pairings (see disconnectStaleSessions).
    await disconnectStaleSessions(connector, sessionTopic(session));
    trackSessionAccount(session);
    return accountId;
  }

  // Standard flow: open the QR pairing modal.
  // Note: if a desktop extension is present, the modal offers it directly.
  // (init() already ran once above — shared by both flows.)
  //
  // LAST LINE OF DEFENSE: never open the deep-link modal from inside a
  // wallet's in-app browser. The wc: link is intercepted by the host
  // wallet itself — self-pairing can never complete, and the user hangs
  // on "Check your wallet…" until the modal timeout (pilot recording,
  // 2026-10-03). The channel choice above should already have routed
  // in-app users to the iframe flow; this guard makes the invariant
  // explicit so a future detection regression can't silently resurrect
  // the dead end.
  if (isHashPackInAppBrowser()) {
    throw new Error(IN_APP_MODAL_BLOCKED_COPY);
  }
  let session;
  try {
    session = await openPairingModal(connector);
  } catch (modalErr) {
    // A dismissed modal is a deliberate cancel, not a failure — propagate
    // it untouched so connect() can reset quietly (no error banner).
    if (isPairingCancelled(modalErr)) throw modalErr;
    // walletRejectionMessage (not String()): the SignClient can reject
    // with a plain {code, message} object — String(obj) would render as
    // "[object Object]" in the UI.
    const msg = walletRejectionMessage(modalErr);
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

  const accountId = accountIdFromSession(session, networkFromChainKey(chain.key));
  if (!accountId) {
    throw new Error("Pairing succeeded but no Hedera account was returned.");
  }
  hcAccountId = accountId;
  // Fresh-pairing hygiene, surgically: drop stale sessions from earlier
  // pairings now that the new one succeeded — sessions only, never
  // pending pairings (see disconnectStaleSessions).
  await disconnectStaleSessions(connector, sessionTopic(session));
  trackSessionAccount(session);
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

const ADAPTERS: Record<WalletAdapterId, WalletAdapter> = {
  hashpack: makeHederaAdapter("hashpack"),
  // Blade and generic WalletConnect pair through the same WalletConnect-based
  // modal, which supports any HIP-820 Hedera wallet.
  blade: makeHederaAdapter("blade"),
  walletconnect: makeHederaAdapter("walletconnect"),
};

/* ------------------------------------------------------------------ */
/* React context + hook                                                 */
/* ------------------------------------------------------------------ */

/**
 * Shares one in-flight async attempt across concurrent callers.
 *
 * Pairing-murder fix (2026-10-03): a second connect() while one is
 * already running must not start a second pairing — concurrent pairings
 * orphan each other's proposals, and cleanup of the loser used to delete
 * the live proposal on the relay (HashPack's "Pair with dApp" sheet
 * vanishing before the user could approve). Concurrent callers share the
 * in-flight attempt's promise; once it settles, the next call starts
 * fresh (retries keep working).
 *
 * Exported (pure, no DOM) so the single-flight contract is unit-tested.
 */
export class SingleFlight<T> {
  private current: Promise<T> | null = null;

  run(start: () => Promise<T>): Promise<T> {
    if (this.current) return this.current;
    const attempt = start();
    this.current = attempt;
    const clear = () => {
      if (this.current === attempt) this.current = null;
    };
    // Both handlers provided: the derived promise never rejects, so no
    // unhandled-rejection noise.
    attempt.then(clear, clear);
    return attempt;
  }

  /** Whether an attempt is currently in flight. */
  get inFlight(): boolean {
    return this.current !== null;
  }
}

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
  /**
   * Single source of truth for in-app-browser detection (B8): the async
   * probe runs once at boot and both the boot auto-connect and the header
   * consume this value. Null while probing.
   */
  const [inAppBrowser, setInAppBrowser] = useState<boolean | null>(null);
  const senderGetter = React.useRef<(() => Promise<TxSender>) | null>(null);
  /**
   * In-flight guard for connect(): concurrent invocations share the one
   * live pairing attempt (SingleFlight) instead of starting a second
   * one. Set when the attempt starts, cleared when it settles — a retry
   * after failure/success starts fresh.
   */
  const connectFlight = React.useRef(new SingleFlight<string>()).current;

  const connect = useCallback(
    (adapterId: WalletAdapterId): Promise<string> =>
      connectFlight.run(async (): Promise<string> => {
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
          // Local-only cleanup on failure — NEVER delete relay pairings
          // here (pairing-murder fix, 2026-10-03): the user may still
          // approve the pending sheet, and the approval then lands in the
          // session store for restore to pick up. disconnectAll() deletes
          // pending pairings, which is what made HashPack's "Pair with
          // dApp" sheet vanish mid-approval.
          dropConnector();
          if (isPairingCancelled(e)) {
            // The user closed the pairing modal themselves — reset to the
            // Connect button quietly. No error banner (the dismissal was
            // deliberate), no failure telemetry (nothing failed).
            throw new PairingCancelledError();
          }
          // Report the reason (not just a failed attempt) so the founder
          // dashboard can show WHY connections fail; fail-silent by design.
          // walletState is "disconnected" — pairing never completed.
          reportError(e, "wallet-connect", { action: "pair-wallet", walletState: "disconnected" });
          recordConversionEvent("wallet_connect_failed");
          // Map known transient wallet-library TypeErrors (e.g. the
          // hedera-wallet-connect "reading 'call'" init race) to actionable
          // copy; everything else passes through unchanged.
          const msg = friendlyWalletError(e);
          setError(msg);
          // Re-throw so callers get the actual error immediately (React state
          // updates are async, so reading wallet.error right after connect()
          // would see the stale null value).
          throw new Error(msg);
        } finally {
          setIsConnecting(false);
        }
      }),
    [],
  );

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

  /* Wallet-side account switch (changed accounts in HashPack mid-session):
     clear the pairing and tell the user to reconnect — the old sign-in
     session is bound to the previous address. */
  useEffect(() => {
    return onAccountChanged(() => {
      senderGetter.current = null;
      setAccount(null);
      setChainId(null);
      setAdapterName(null);
      writeStoredAdapterId(null);
      setError(
        "Your wallet switched accounts. Reconnect to continue with the new account.",
      );
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
        // Store the probe result in context (B8): the header consumes this
        // instead of the sync check, which is blind on iOS.
        setInAppBrowser(inApp);
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
    () => ({ account, chainId, adapterName, isConnecting, error, bootSettled, userDisconnected, inAppBrowser, connect, disconnect, getTxSender }),
    [account, chainId, adapterName, isConnecting, error, bootSettled, userDisconnected, inAppBrowser, connect, disconnect, getTxSender],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
