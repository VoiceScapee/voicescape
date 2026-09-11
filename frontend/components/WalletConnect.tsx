"use client";

/**
 * Wallet sign-in button. Session-aware: drives full wallet sign-in when the
 * root SessionProvider is mounted, degrades to connect-only otherwise.
 *
 * Lives here (not in lib/wallet) so lib/wallet and lib/session stay
 * cycle-free: this component imports from both, neither imports it.
 */
import { useEffect, useRef, useState } from "react";
import {
  isHashPackInAppBrowser,
  useWallet,
  WALLET_ADAPTERS,
  type WalletAdapterId,
} from "@/lib/wallet";
import { useSession } from "@/lib/session";
import { getActiveChain } from "@/lib/chains";
import { useLanguage } from "@/lib/i18n/LanguageContext";

/* Wallet sign-in button (reskinned in the design pass)                     */
/* ------------------------------------------------------------------ */

function shortAccount(account: string): string {
  return account.length > 13 ? `${account.slice(0, 6)}…${account.slice(-4)}` : account;
}

export function WalletConnect() {
  const { account, isConnecting, error, connect, disconnect } = useWallet();
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const chain = getActiveChain();
  const options = WALLET_ADAPTERS.filter((a) => a.chains.includes(chain.key));

  const status = session?.status ?? (account ? "connected" : "anonymous");
  const isAuthenticated = session?.isAuthenticated ?? false;
  const signing = status === "signing";
  const signInError = session?.error;
  // Inside HashPack's browser the wallet auto-connects on mount — show a
  // connecting state instead of the adapter picker. If auto-connect
  // failed, fall through to the manual picker so the user can retry.
  const inHashPackBrowser = isHashPackInAppBrowser();
  const autoConnectPending = inHashPackBrowser && !error && !signInError;

  async function handlePick(adapterId: WalletAdapterId) {
    setShowOptions(false);
    if (session) {
      try {
        await session.signIn(adapterId);
      } catch {
        // Error surfaces via session.error.
      }
    } else {
      await connect(adapterId);
    }
  }

  async function handleSignIn() {
    if (!session) return;
    try {
      await session.signIn();
    } catch {
      // Error surfaces via session.error.
    }
  }

  // Close the wallet picker when clicking outside or pressing Escape.
  useEffect(() => {
    if (!showOptions) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setShowOptions(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowOptions(false);
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
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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
          <button
            onClick={handleSignIn}
            disabled={signing}
            className="vs-btn vs-btn-primary"
            style={{ padding: "6px 14px", fontSize: 13 }}
          >
            {signing ? t("wallet.checkWallet") : t("wallet.signIn")}
          </button>
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
  // show a connecting state (falls back to the picker on failure).
  if (autoConnectPending) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          disabled
          className="vs-btn vs-btn-primary"
          style={{ padding: "9px 22px", fontSize: 14, opacity: 0.75, cursor: "wait" }}
        >
          {t("wallet.connectingHashPack")}
        </button>
      </div>
    );
  }

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        onClick={() => setShowOptions((s) => !s)}
        disabled={isConnecting || signing}
        className="vs-btn vs-btn-primary"
        style={{ padding: "9px 22px", fontSize: 14 }}
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
            background: "#101022",
            border: "1px solid var(--vs-border)",
            borderRadius: "var(--vs-radius)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}
        >
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => void handlePick(o.id)}
              style={{
                display: "block",
                width: "100%",
                padding: "10px 12px",
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
                (e.currentTarget as HTMLButtonElement).style.background = "rgba(16,185,129,0.15)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "none";
              }}
            >
              {o.name}
            </button>
          ))}
          <div
            className="vs-mono"
            style={{ padding: "8px 12px", fontSize: 11, color: "var(--vs-muted)" }}
          >
            {chain.label}
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
