/**
 * Voicescape wallet sign-in — React session layer.
 *
 * `SessionProvider` sits inside `WalletProvider` and turns a wallet
 * *connection* into a wallet *sign-in*:
 *
 *  1. The user connects a wallet (existing `useWallet` flow).
 *  2. They sign an EIP-4361-style "Sign in with Voicescape" message
 *     (EVM: personal_sign · Hedera: HashConnect signMessages).
 *  3. The signature is POSTed ONCE to /api/auth/login, which verifies it
 *     server-side and returns a stateless HMAC session token (7 days).
 *  4. The token rides in the `x-vs-session` header on every write; the
 *     server verifies it with no I/O and no server-side session storage.
 *
 * Wallets that cannot sign stay connect-only and are labelled as such —
 * authentication is never faked.
 *
 * Usage:
 *   const { session, isAuthenticated, signIn, signOut, authHeader } = useSession();
 *   fetch(url, { headers: { ...authHeader() } })
 */

"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getHederaPairing, useWallet, WALLET_ADAPTERS, type WalletAdapterId } from "./wallet";
import { getActiveChain } from "./chains";
import { setAuthHeaderProvider } from "./auth-client";
import {
  SESSION_HEADER,
  SESSION_TTL_MS,
  SignInRequired,
  buildSignInMessage,
  bytesToHex,
  canonicalAddress,
  createSession,
  generateNonce,
  isHederaAccountId,
  restoreSession,
  serializeSession,
  verifyEvmSignature,
  type StoredSession,
} from "./session-message";

export type { StoredSession };
export { SignInRequired, SESSION_HEADER };

const STORAGE_KEY = "vs-session-v1";

export type SessionStatus =
  | "loading" // restoring from storage
  | "anonymous" // no wallet connected
  | "connected" // wallet connected, not signed in
  | "signing" // signature request in flight
  | "authenticated";

export interface SignerInfo {
  /** Human label, e.g. "HashPack", "MetaMask". */
  name: string;
  /** False → this wallet is connect-only; sign-in is not offered. */
  canSign: boolean;
  /** Why not, when canSign is false. */
  noSignReason?: string;
}

const ADAPTER_SIGNERS: Record<WalletAdapterId, SignerInfo> = {
  hashpack: { name: "HashPack", canSign: true },
  blade: { name: "Blade", canSign: true },
  walletconnect: { name: "WalletConnect", canSign: true },
  metamask: { name: "MetaMask", canSign: true },
};

export interface SessionContextValue {
  status: SessionStatus;
  /** Null unless status === "authenticated". */
  session: StoredSession | null;
  isAuthenticated: boolean;
  /** Connected wallet info (null when no wallet). */
  signer: SignerInfo | null;
  /** Connected wallet account id (0.0.x or 0x…), regardless of sign-in. */
  account: string | null;
  /** Last sign-in error, if any. */
  error: string | null;
  /** Connect (if needed) and sign the sign-in message. */
  signIn: (adapterId?: WalletAdapterId) => Promise<StoredSession>;
  /** Clear the session and disconnect the wallet. */
  signOut: () => void;
  /** Headers to attach to authenticated API calls. {} when signed out. */
  authHeader: () => Record<string, string>;
  /** The session token for the header, or null. */
  token: () => string | null;
  /** Throw SignInRequired unless authenticated. */
  requireSession: () => StoredSession;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function readStored(): StoredSession | null {
  try {
    const { session } = restoreSession(window.localStorage.getItem(STORAGE_KEY));
    return session;
  } catch {
    return null;
  }
}

function writeStored(s: StoredSession | null) {
  try {
    if (s) window.localStorage.setItem(STORAGE_KEY, serializeSession(s));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable — session just won't persist */
  }
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  const chain = getActiveChain();
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [session, setSession] = useState<StoredSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signingRef = useRef(false);

  const account = wallet.account;
  const adapterId = (wallet.adapterName ?? null) as WalletAdapterId | null;
  const signer: SignerInfo | null = adapterId ? (ADAPTER_SIGNERS[adapterId] ?? null) : null;

  /* Restore a persisted session on mount. The session is a bearer token
     (server-signed, verified on every request), so it stays valid even
     before the wallet reconnects — that gives the honest 7-day reload.
     If the user later connects a *different* wallet, the account-sync
     effect below drops it: a session belongs to exactly one wallet. */
  useEffect(() => {
    const stored = readStored();
    if (stored && stored.chainId === chain.chainId) {
      setSession(stored);
      setStatus("authenticated");
      return;
    }
    if (stored) writeStored(null); // stale: wrong chain or expired
    setSession(null);
    setStatus(account ? "connected" : "anonymous");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* React to wallet connect / disconnect / account switch. */
  useEffect(() => {
    if (status === "loading" || status === "signing") return;
    if (!account) {
      setSession(null);
      writeStored(null);
      setStatus("anonymous");
      return;
    }
    setSession((prev) => {
      const accountAddr = canonicalAddress(account);
      if (prev && prev.chainId === chain.chainId && accountAddr && prev.address === accountAddr) {
        setStatus("authenticated");
        return prev;
      }
      writeStored(null);
      setStatus("connected");
      return null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  const signHederaMessage = useCallback(async (message: string, accountId: string): Promise<string> => {
    const pairing = getHederaPairing();
    if (!pairing) throw new Error("Wallet session not ready — reconnect and try again.");
    const { AccountId } = await import("@hashgraph/sdk");
    const results = await pairing.hc.signMessages(AccountId.fromString(accountId), message);
    const first = results?.[0];
    const sig = first?.signature;
    if (!sig || sig.length === 0) throw new Error("The wallet did not return a signature.");
    const returnedAccount = first.accountId?.toString?.();
    if (returnedAccount && returnedAccount !== accountId) {
      throw new Error("The wallet signed with a different account. Reconnect and try again.");
    }
    return "0x" + bytesToHex(sig instanceof Uint8Array ? sig : new Uint8Array(sig));
  }, []);

  const signEvmMessage = useCallback(async (message: string, address: string): Promise<string> => {
    const eth = (window as unknown as { ethereum?: unknown }).ethereum as
      | { request?: (args: { method: string; params: unknown[] }) => Promise<unknown> }
      | undefined;
    if (!eth?.request) throw new Error("No Ethereum provider found.");
    const signature = (await eth.request({
      method: "personal_sign",
      params: [message, address],
    })) as string;
    if (typeof signature !== "string" || !signature.startsWith("0x")) {
      throw new Error("The wallet did not return a signature.");
    }
    return signature;
  }, []);

  const signIn = useCallback(
    async (targetAdapter?: WalletAdapterId): Promise<StoredSession> => {
      if (signingRef.current) throw new Error("A sign-in request is already in progress.");
      signingRef.current = true;
      setError(null);
      setStatus("signing");
      try {
        let activeAdapter = adapterId;
        let activeAccount = account;
        if ((!activeAdapter || !activeAccount) && targetAdapter) {
          // connect() resolves with the account, so no re-render wait needed.
          // If it fails, propagate the actual wallet error instead of a generic message.
          activeAccount = await wallet.connect(targetAdapter);
          activeAdapter = targetAdapter;
          if (!activeAccount) {
            // wallet.connect() sets wallet.error with the specific failure reason.
            // Throw that instead of the generic "Connect a wallet first."
            throw new Error(wallet.error || "Wallet connection failed. Please try again.");
          }
        }
        if (!activeAdapter || !activeAccount) {
          throw new Error("Connect a wallet first.");
        }
        const info = ADAPTER_SIGNERS[activeAdapter];
        if (!info?.canSign) {
          throw new Error(
            `${info?.name ?? "This wallet"} is connect-only: it cannot sign messages, so it can't sign you in.`,
          );
        }

        const now = new Date();
        const message = buildSignInMessage({
          address: activeAccount,
          // Bind the signature to this deployment (EIP-4361 "uri"): a
          // phishing site asking the user to sign the same text gets a
          // credential the real server rejects.
          uri: window.location.origin,
          chainId: chain.chainId,
          nonce: generateNonce(),
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
        });

        let signature: string;
        if (isHederaAccountId(activeAccount)) {
          signature = await signHederaMessage(message, activeAccount);
        } else {
          signature = await signEvmMessage(message, activeAccount);
          // Client-side check before we trust the session locally.
          if (!verifyEvmSignature(message, signature, activeAccount)) {
            throw new Error(
              "Signature verification failed — the wallet may have signed with a different account.",
            );
          }
        }

        const canonical = canonicalAddress(activeAccount);
        if (!canonical) throw new Error("Unsupported wallet address format.");
        // Exchange the fresh wallet signature for a stateless session
        // token: the server verifies the signature (Hedera keys are
        // checked against the mirror node), binds the nonce, and returns
        // a 7-day HMAC token. This is what surfaces connect-only wallets
        // with a clear error instead of a session that 401s on every
        // write. The client never sends the raw signature again.
        let token: string;
        let expiresAtMs: number;
        try {
          const loginRes = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ credential: { message, signature } }),
          });
          const loginJson = (await loginRes.json().catch(() => null)) as {
            ok?: boolean;
            error?: string;
            token?: string;
            session?: { address?: string; chainId?: number; expiresAtMs?: number };
          } | null;
          if (!loginRes.ok || !loginJson?.ok || typeof loginJson.token !== "string") {
            throw new Error(loginJson?.error ?? "Wallet sign-in could not be verified.");
          }
          token = loginJson.token;
          expiresAtMs = loginJson.session?.expiresAtMs ?? 0;
        } catch (e) {
          if (e instanceof Error) throw e;
          throw new Error("Wallet sign-in could not be verified — check your connection and try again.");
        }
        const created = createSession({
          token,
          address: canonical,
          chainId: chain.chainId,
          adapterId: activeAdapter,
          expiresAtMs,
        });
        setSession(created);
        writeStored(created);
        setStatus("authenticated");
        return created;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Sign-in failed.";
        // User rejection shouldn't look like an app error.
        const rejected = /user (rejected|denied)|rejected the request/i.test(msg);
        setError(rejected ? "Signature request was dismissed in the wallet." : msg);
        setSession(null);
        writeStored(null);
        setStatus(account ? "connected" : "anonymous");
        throw e instanceof Error ? e : new Error(msg);
      } finally {
        signingRef.current = false;
      }
    },
    [adapterId, account, chain.chainId, signEvmMessage, signHederaMessage, wallet],
  );

  const signOut = useCallback(() => {
    setSession(null);
    writeStored(null);
    setError(null);
    void wallet.disconnect();
    setStatus("anonymous");
  }, [wallet]);

  const authHeader = useCallback((): Record<string, string> => {
    if (!session) return {};
    return { [SESSION_HEADER]: session.token };
  }, [session]);

  /* Keep the plain client helpers (postJson, pin*) in sync: they attach the
     session header automatically, including across dust-fee retries. */
  useEffect(() => {
    setAuthHeaderProvider(() => authHeader());
    return () => setAuthHeaderProvider(null);
  }, [authHeader]);

  const token = useCallback(() => {
    if (!session) return null;
    return session.token;
  }, [session]);

  const requireSession = useCallback((): StoredSession => {
    if (!session || status !== "authenticated") throw new SignInRequired();
    return session;
  }, [session, status]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      session: status === "authenticated" ? session : null,
      isAuthenticated: status === "authenticated" && !!session,
      signer,
      account,
      error,
      signIn,
      signOut,
      authHeader,
      token,
      requireSession,
    }),
    [status, session, signer, account, error, signIn, signOut, authHeader, token, requireSession],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>.");
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Route/UI gating                                                     */
/* ------------------------------------------------------------------ */

/**
 * Gate children behind an active signed-in session. When the user is not
 * signed in, renders a sign-in card instead — with the wallet CTA, never a
 * dead end.
 */
export function RequireSession({
  children,
  title = "Sign in to continue",
  description = "Connect your wallet and sign the sign-in message to use this feature.",
}: {
  children: React.ReactNode;
  title?: string;
  description?: string;
}) {
  const { status, isAuthenticated } = useSession();

  if (status === "loading") {
    return (
      <div style={{ padding: "48px 24px", textAlign: "center", color: "var(--vs-muted)" }}>
        Restoring your session…
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div style={{ maxWidth: 480, margin: "48px auto", padding: "0 24px", textAlign: "center" }}>
        <div
          className="vs-glass"
          style={{ padding: 32, display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}
        >
          <div style={{ fontSize: 20, fontWeight: 700 }}>{title}</div>
          <p style={{ color: "var(--vs-muted)", fontSize: 14, margin: 0 }}>{description}</p>
          <div style={{ marginTop: 8 }}>
            <SignInButton />
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * Standalone sign-in button. Imported lazily-safe: it lives next to the
 * session context so gated pages don't need the wallet module's component.
 * (The header/nav `WalletConnect` in components/WalletConnect.tsx is the
 * same flow with full connection-state chrome.)
 */
function SignInButton() {
  const { signIn, status } = useSession();
  const chain = getActiveChain();
  const [showOptions, setShowOptions] = useState(false);
  const options = WALLET_ADAPTERS.filter((a) => a.chains.includes(chain.key));
  const busy = status === "signing";

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setShowOptions((s) => !s)}
        disabled={busy}
        className="vs-btn vs-btn-primary"
        style={{ padding: "10px 26px", fontSize: 15 }}
      >
        {busy ? "Check your wallet…" : "Sign in with wallet"}
      </button>
      {showOptions && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            top: "115%",
            zIndex: 50,
            minWidth: 220,
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
              onClick={() => {
                setShowOptions(false);
                void signIn(o.id).catch(() => {});
              }}
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
            >
              {o.name}
            </button>
          ))}
          <div className="vs-mono" style={{ padding: "8px 12px", fontSize: 11, color: "var(--vs-muted)" }}>
            {chain.label}
          </div>
        </div>
      )}
    </div>
  );
}
