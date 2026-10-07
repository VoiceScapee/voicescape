"use client";

/**
 * Wallet sign-in button. Session-aware: drives full wallet sign-in when the
 * root SessionProvider is mounted, degrades to connect-only otherwise.
 *
 * Lives here (not in lib/wallet) so lib/wallet and lib/session stay
 * cycle-free: this component imports from both, neither imports it.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import ExternalLink from "./ExternalLink";
import { deriveUsername, getVanityName } from "@/lib/identity";
import { NotificationBell } from "./NotificationBell";
import {
  hasInjectedHederaWallet,
  isHashPackInAppBrowser,
  isMobileUserAgent,
  isPairingCancelled,
  OPEN_WALLET_CONNECT_EVENT,
  resolveInAppHeaderState,
  shouldSuggestWalletInstall,
  useWallet,
  WALLET_ADAPTERS,
  type WalletAdapterId,
} from "@/lib/wallet";
import { useSession } from "@/lib/session";
import { getActiveChain } from "@/lib/chains";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { recordConversionEvent } from "@/lib/metrics";

/* Wallet sign-in button (reskinned in the design pass)                     */
/* ------------------------------------------------------------------ */

function shortAccount(account: string): string {
  return account.length > 13 ? `${account.slice(0, 6)}…${account.slice(-4)}` : account;
}

/**
 * True when the browser has an injected EVM provider (MetaMask or another
 * Ethereum wallet). Those wallets can't sign Hedera-native transactions,
 * but the underlying key IS a valid Hedera key: importing it into HashPack
 * gives the same address. Used to show the same-seed import hint in the
 * wallet picker instead of letting the user hit a dead end.
 */
function hasEvmProvider(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { ethereum?: unknown };
  return w.ethereum !== undefined && w.ethereum !== null;
}

/**
 * Elapsed-time + cancel for the wallet sign-in poll. The Hedera login
 * watches the mirror for up to 2 minutes; without this the user stares at
 * "Check your wallet…" with no sense of progress and no way out.
 */
function SignInProgress({ startedAt, onCancel }: { startedAt: number; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <div style={{ fontSize: 12, color: "var(--vs-muted)", width: "100%" }}>
      Waiting for your wallet approval… {secs}s elapsed.
      <button
        onClick={onCancel}
        className="vs-btn vs-btn-ghost"
        style={{ padding: "4px 10px", fontSize: 12, marginLeft: 8 }}
      >
        Cancel
      </button>
    </div>
  );
}

export function WalletConnect({ skipAutoSignIn = false }: { skipAutoSignIn?: boolean } = {}) {
  const { account, isConnecting, error, bootSettled, userDisconnected, inAppBrowser, connect, disconnect } = useWallet();
  const { t } = useLanguage();
  // SessionProvider is mounted at the root layout; when present the button
  // drives full sign-in, otherwise it degrades to connect-only.
  let session: ReturnType<typeof useSession> | null = null;
  try {
    session = useSession();
  } catch {
    session = null;
  }
  const [showOptions, setShowOptions] = useState(false);
  // No-wallet pre-flight (desktop): when no wallet extension is installed,
  // opening the QR pairing modal is a dead end — every option funnels into
  // the same modal and it waits forever. Show install guidance instead,
  // with an explicit "show the QR code anyway" escape hatch for people
  // pairing from a phone wallet.
  const [showNoWalletHelp, setShowNoWalletHelp] = useState(false);
  const [pendingAdapter, setPendingAdapter] = useState<WalletAdapterId | null>(null);
  const [qrBypass, setQrBypass] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const chain = getActiveChain();
  const options = WALLET_ADAPTERS.filter((a) => a.chains.includes(chain.key));

  const status = session?.status ?? (account ? "connected" : "anonymous");
  const isAuthenticated = session?.isAuthenticated ?? false;
  const signing = status === "signing";
  const signInError = session?.error;
  // Inside HashPack's browser the wallet auto-connects on mount — show a
  // connecting state only while something is actually happening (boot
  // detection still running, or a real connect attempt in flight). Never
  // show "Connecting…" when the user explicitly disconnected or when boot
  // already settled with no attempt running — that was the unsolicited
  // frozen "Connecting…" state.
  // Single source of truth (B8): the async probe result stored in wallet
  // context. The sync isHashPackInAppBrowser() is blind inside HashPack's
  // iOS in-app browser, so while the probe is still running (null) we fall
  // back to the sync signals rather than the dead-end QR picker.
  const inHashPackBrowser = inAppBrowser ?? isHashPackInAppBrowser();
  const inAppState = resolveInAppHeaderState({
    inHashPackBrowser,
    account,
    isConnecting,
    bootSettled,
    userDisconnected,
    error,
    signInError: signInError ?? null,
  });
  const autoConnectPending = inAppState === "connecting";
  // In-app browser, boot settled, nothing in flight, no error: offer an
  // explicit one-tap reconnect instead of a fake "Connecting…" or a QR
  // picker that can't work inside the wallet app.
  const showInAppRetry = inAppState === "retry";

  async function runPick(adapterId: WalletAdapterId) {
    setShowOptions(false);
    setShowNoWalletHelp(false);
    try {
      if (session) {
        try {
          await session.signIn(adapterId);
        } catch {
          // Error surfaces via session.error.
        }
      } else {
        await connect(adapterId);
      }
    } catch (e) {
      // A dismissed pairing modal is a deliberate cancel — the button
      // already reset quietly inside connect()/signIn; nothing to show.
      if (!isPairingCancelled(e)) throw e;
    }
  }

  async function handlePick(adapterId: WalletAdapterId) {
    // Desktop with no wallet installed: say so plainly instead of opening
    // the identical dead-end modal — unless the user explicitly asked for
    // the QR code (they may be pairing from their phone).
    if (
      !qrBypass &&
      shouldSuggestWalletInstall({
        isMobile: isMobileUserAgent(),
        inHashPackBrowser: isHashPackInAppBrowser(),
        hasInjectedWallet: hasInjectedHederaWallet(),
      })
    ) {
      setPendingAdapter(adapterId);
      setShowNoWalletHelp(true);
      return;
    }
    await runPick(adapterId);
  }

  function handleShowQrAnyway() {
    const adapter = pendingAdapter;
    setQrBypass(true);
    setPendingAdapter(null);
    if (adapter) void runPick(adapter);
    else setShowNoWalletHelp(false);
  }

  async function handleSignIn() {
    if (!session) return;
    try {
      await session.signIn();
    } catch {
      // Error surfaces via session.error.
    }
  }

  // Two visible steps, not one surprise: connecting the wallet (step 1) is
  // followed by a wallet signature for the 7-day session (step 2). The old
  // code fired step 2 instantly, so the login prompt ambushed the user right
  // after the pairing prompt — two app-switches disguised as one gesture.
  // Now the step-2 copy below is on screen for a beat BEFORE the wallet
  // prompt appears, and tip surfaces can opt out entirely via
  // skipAutoSignIn (tipping never uses the session).
  const autoSignFor = useRef<string | null>(null);
  const [autoSignArmed, setAutoSignArmed] = useState(false);
  useEffect(() => {
    if (skipAutoSignIn) return;
    if (!session || session.status !== "connected" || !account) return;
    if (autoSignFor.current === account) return;
    autoSignFor.current = account;
    // Funnel telemetry: a wallet connection succeeded. Aggregate counter
    // only — recordConversionEvent never throws and never stores identity.
    recordConversionEvent("wallet_connected");
    setAutoSignArmed(true);
    const t = setTimeout(() => {
      setAutoSignArmed(false);
      void session.signIn().catch(() => {
        // Dismissal surfaces via session.error; the user can sign in later.
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [session, account, skipAutoSignIn]);

  // In-chat one-tap approvals (BuddyActionCard) live outside the wallet
  // provider, so they can't call connect() directly. When the pairing is
  // missing or stale they dispatch OPEN_WALLET_CONNECT_EVENT; the nearest
  // mounted WalletConnect opens its pairing UI in response.
  useEffect(() => {
    const open = () => setShowOptions(true);
    window.addEventListener(OPEN_WALLET_CONNECT_EVENT, open);
    return () => window.removeEventListener(OPEN_WALLET_CONNECT_EVENT, open);
  }, []);

  // Close the wallet picker when clicking outside or pressing Escape.
  useEffect(() => {
    if (!showOptions) return;
    const closePicker = () => {
      setShowOptions(false);
      setShowNoWalletHelp(false);
      setPendingAdapter(null);
      setQrBypass(false);
    };
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        closePicker();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePicker();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showOptions]);

  // Authenticated: address chip + sign out.
  if (isAuthenticated && account) {
    // Prefer the wallet's claimed custom name (remembered at publish);
    // the derived name is only the fallback. Otherwise a wallet that
    // claimed a vanity name lands on a 404 for its derived username.
    const myUsername = getVanityName(account) ?? deriveUsername(account);
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <NotificationBell address={account} />
        {myUsername && (
          <Link
            href={`/${myUsername}`}
            className="vs-btn vs-btn-ghost"
            style={{ padding: "6px 14px", fontSize: 13, textDecoration: "none" }}
          >
            {t("wallet.myPage")}
          </Link>
        )}
        <span
          className="vs-mono"
          title={account}
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            border: "1px solid var(--vs-border)",
            background: "var(--vs-glass)",
            fontSize: 13,
            color: "var(--vs-text)",
          }}
        >
          {shortAccount(account)}
        </span>
        <button
          onClick={() => session?.signOut()}
          className="vs-btn vs-btn-ghost"
          style={{ padding: "6px 14px", fontSize: 13 }}
        >
          {t("wallet.signOut")}
        </button>
      </div>
    );
  }

  // Signed in from a previous visit, wallet not connected yet: the session
  // still authenticates API calls. Offer sign-out, not a second sign-in.
  if (isAuthenticated && session?.session) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span
          className="vs-mono"
          title={session.session.address}
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            border: "1px solid var(--vs-border)",
            background: "var(--vs-glass)",
            fontSize: 13,
            color: "var(--vs-text)",
          }}
        >
          {shortAccount(session.session.address)} ✓
        </span>
        <button
          onClick={() => session?.signOut()}
          className="vs-btn vs-btn-ghost"
          style={{ padding: "6px 14px", fontSize: 13 }}
        >
          {t("wallet.signOut")}
        </button>
      </div>
    );
  }

  // Connected but not signed in: prompt for the signature.
  if (account) {
    // Same vanity-name preference as the authenticated branch above.
    const myUsername = getVanityName(account) ?? deriveUsername(account);
    const signInStartedAt = session?.signInStartedAt ?? null;
    const showProgress = signing && signInStartedAt !== null;
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {/* Two-step sequence, always visible: step 1 done, step 2 pending.
            The wallet's signature prompt never arrives as a surprise. */}
        <div style={{ fontSize: 12, color: "var(--vs-muted)", width: "100%" }}>
          <div>✓ Step 1 — wallet connected ({shortAccount(account)})</div>
          <div>
            {showProgress || autoSignArmed
              ? "Step 2 — check your wallet to sign the login…"
              : "Step 2 — sign the login request in your wallet"}
          </div>
        </div>
        {myUsername && (
          <Link
            href={`/${myUsername}`}
            className="vs-btn vs-btn-ghost"
            style={{ padding: "6px 14px", fontSize: 13, textDecoration: "none" }}
          >
            {t("wallet.myPage")}
          </Link>
        )}
        <span
          className="vs-mono"
          title={account}
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            border: "1px dashed var(--vs-border)",
            background: "var(--vs-glass)",
            fontSize: 13,
            color: "var(--vs-muted)",
          }}
        >
          {shortAccount(account)}
        </span>
        {session ? (
          <>
            <button
              onClick={handleSignIn}
              disabled={signing}
              className="vs-btn vs-btn-primary"
              style={{ padding: "6px 14px", fontSize: 13 }}
            >
              {signing ? t("wallet.checkWallet") : t("wallet.signIn")}
            </button>
            {showProgress ? (
              <SignInProgress
                startedAt={signInStartedAt as number}
                onCancel={() => session?.cancelSignIn()}
              />
            ) : (
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--vs-muted)",
                  width: "100%",
                }}
              >
                This proves you own the wallet — 1 tinybar to yourself, not a payment.
                Sign once — you&apos;re signed in for 7 days.
              </div>
            )}
          </>
        ) : null}
        <button
          onClick={() => void disconnect()}
          className="vs-btn vs-btn-ghost"
          style={{ padding: "6px 14px", fontSize: 13 }}
        >
          {t("wallet.disconnect")}
        </button>
        {signInError && (
          <div style={{ color: "#f87171", fontSize: 12, width: "100%" }}>{signInError}</div>
        )}
      </div>
    );
  }

  // Anonymous: inside HashPack's browser the wallet is auto-connecting —
  // show a connecting state only while the attempt is real (see above).
  if (autoConnectPending) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          disabled
          className="vs-btn vs-btn-primary"
          style={{ padding: "12px 22px", fontSize: 14, opacity: 0.75, cursor: "wait" }}
        >
          {t("wallet.connectingHashPack")}
        </button>
      </div>
    );
  }

  // Anonymous: in-app browser, boot settled, nothing happening — one-tap
  // reconnect the user explicitly triggers.
  if (showInAppRetry) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={() => void connect("hashpack").catch(() => {
            // Failure surfaces via wallet.error below.
          })}
          disabled={isConnecting}
          className="vs-btn vs-btn-primary"
          style={{ padding: "12px 22px", fontSize: 14 }}
        >
          {t("wallet.connectHashPack")}
        </button>
      </div>
    );
  }

  // Anonymous: in-app browser with a failed attempt (B8). The generic
  // QR/deep-link picker below cannot work inside the wallet app, so offer
  // the explicit one-tap retry with the error visible instead of a dead end.
  // resolveInAppHeaderState deliberately keeps error → "default" (its unit
  // tests pin that), so this branch lives here in the component.
  if (inHashPackBrowser && (error || signInError) && !account) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          onClick={() => void connect("hashpack").catch(() => {
            // Failure surfaces via wallet.error below.
          })}
          disabled={isConnecting}
          className="vs-btn vs-btn-primary"
          style={{ padding: "12px 22px", fontSize: 14 }}
        >
          {t("wallet.connectHashPack")} — try again
        </button>
        <div style={{ color: "#f87171", fontSize: 12, width: "100%", maxWidth: 260 }}>
          {signInError ?? error}
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        onClick={() => setShowOptions((s) => !s)}
        disabled={isConnecting || signing}
        className="vs-btn vs-btn-primary"
        style={{ padding: "12px 22px", fontSize: 14 }}
      >
        {isConnecting ? t("wallet.connecting") : signing ? t("wallet.checkWallet") : t("wallet.signInWithWallet")}
      </button>
      {showOptions && (
        <div
          style={{
            position: "absolute",
            right: 0,
            top: "115%",
            zIndex: 50,
            minWidth: 210,
            padding: 6,
            overflow: "hidden",
            background: "var(--vs-panel)",
            border: "1px solid var(--vs-border)",
            borderRadius: "var(--vs-radius)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}
        >
          {showNoWalletHelp ? (
            <div style={{ padding: "10px 12px" }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                You&apos;ll need a Hedera wallet to connect
              </div>
              <div style={{ fontSize: 12.5, color: "var(--vs-muted)", marginBottom: 10 }}>
                Voicescape signs you in with your wallet — no passwords. No
                wallet app was found in this browser, so the pairing screen
                would just wait forever.
              </div>
              <ExternalLink
                href="https://www.hashpack.app"
                className="vs-btn vs-btn-primary"
                style={{
                  display: "block",
                  textAlign: "center",
                  padding: "9px 12px",
                  fontSize: 13,
                  textDecoration: "none",
                  marginBottom: 8,
                }}
              >
                Get HashPack (free)
              </ExternalLink>
              <div style={{ fontSize: 12, color: "var(--vs-muted)" }}>
                HashPack is free and takes about 2 minutes to set up.
              </div>
              <button
                onClick={handleShowQrAnyway}
                style={{
                  display: "block",
                  width: "100%",
                  marginTop: 10,
                  padding: "8px 12px",
                  background: "none",
                  border: "1px solid var(--vs-border)",
                  borderRadius: 8,
                  color: "var(--vs-accent)",
                  fontFamily: "var(--vs-font)",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                I have a wallet on my phone — show the QR code
              </button>
            </div>
          ) : (
            options.map((o) => (
              <button
                key={o.id}
                onClick={() => void handlePick(o.id)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "12px",
                  textAlign: "left",
                  cursor: "pointer",
                  background: "none",
                  border: "none",
                  borderRadius: 8,
                  color: "var(--vs-text)",
                  fontFamily: "var(--vs-font)",
                  fontSize: 14,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(130,89,239,0.15)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "none";
                }}
              >
                {o.name}
              </button>
            ))
          )}
          <div
            className="vs-mono"
            style={{ padding: "8px 12px", fontSize: 11, color: "var(--vs-muted)" }}
          >
            {chain.label}
          </div>
          <div
            style={{
              padding: "8px 12px",
              borderTop: "1px solid var(--vs-border)",
              fontSize: 12,
              color: "var(--vs-muted)",
            }}
          >
            New to crypto?{" "}
            <Link
              href="/new-to-web3"
              style={{ color: "var(--vs-accent)", textDecoration: "underline" }}
            >
              Start here →
            </Link>
            <div style={{ marginTop: 4 }}>
              New to wallets?{" "}
              <ExternalLink
                href="https://www.hashpack.app"
                style={{ color: "var(--vs-accent)", textDecoration: "underline" }}
              >
                Get HashPack (free)
              </ExternalLink>
            </div>
            {hasEvmProvider() && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--vs-border)" }}>
                Using MetaMask or another Ethereum wallet?{" "}
                <ExternalLink
                  href="https://www.hashpack.app"
                  style={{ color: "var(--vs-accent)", textDecoration: "underline" }}
                >
                  Import your existing key into HashPack
                </ExternalLink>
                <div style={{ marginTop: 4, fontSize: 11 }}>
                  It&apos;s the same key, so it&apos;s the same address — no new
                  wallet to back up. Takes about 2 minutes.
                </div>
              </div>
            )}
            <div style={{ marginTop: 4, fontSize: 11 }}>
              A wallet lets you create pages and receive tips.
            </div>
          </div>
        </div>
      )}
      {(error || signInError) && (
        <div
          style={{
            color: "#f87171",
            fontSize: 12,
            marginTop: 6,
            maxWidth: 240,
          }}
        >
          {signInError ?? error}
        </div>
      )}
    </div>
  );
}
