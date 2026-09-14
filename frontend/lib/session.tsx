/**
 * Voicescape wallet sign-in — React session layer.
 *
 * `SessionProvider` sits inside `WalletProvider` and turns a wallet
 * *connection* into a wallet *sign-in*:
 *
 *  1. The user connects a wallet (existing `useWallet` flow).
 *  2. They sign a tiny login transaction in the wallet — a 1-tinybar
 *     self-transfer whose memo carries the login challenge
 *     (EVM: personal_sign · Hedera: hedera_signAndExecuteTransaction,
 *     the same primitive tipping uses).
 *  3. The transaction id is POSTed ONCE to /api/auth/login, which verifies
 *     the confirmed transaction server-side (mirror node) and returns a
 *     stateless HMAC session token (7 days).
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

import { usePathname } from "next/navigation";
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
  /** Human label, e.g. "HashPack", "Blade". */
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
  /** Connect (if needed) and complete the wallet sign-in (message or login transaction). */
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
  /**
   * Fresh read of the session that never goes stale inside effects. The
   * account-sync effect below must see the session restored by the mount
   * effect even though both run in the same commit (state closures would
   * still hold the initial null).
   */
  const sessionRef = useRef<StoredSession | null>(null);
  const setSessionBoth = useCallback((s: StoredSession | null) => {
    sessionRef.current = s;
    setSession(s);
  }, []);

  const account = wallet.account;
  const adapterId = (wallet.adapterName ?? null) as WalletAdapterId | null;
  const signer: SignerInfo | null = adapterId ? (ADAPTER_SIGNERS[adapterId] ?? null) : null;

  /* Restore a persisted session on mount (effect, not render — avoids an
     SSR hydration mismatch). The session is a bearer token (server-signed,
     verified on every request), so it stays valid even before the wallet
     reconnects — that gives the honest 7-day reload. */
  const restoredRef = useRef(false);
  const pathname = usePathname();
  useEffect(() => {
    const stored = readStored();
    if (stored && stored.chainId === chain.chainId) {
      setSessionBoth(stored);
      setStatus("authenticated");
    } else {
      if (stored) writeStored(null); // stale: wrong chain or expired
      setSessionBoth(null);
      setStatus(account ? "connected" : "anonymous");
    }
    restoredRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Re-verify the session on every route change. HashPack's in-app browser
     can drop React context on navigation — this restores the session from
     storage so the user never has to sign in twice. Never wipes, only restores. */
  useEffect(() => {
    if (!restoredRef.current) return; // mount effect handles the first load
    const stored = readStored();
    if (stored && stored.chainId === chain.chainId && !sessionRef.current) {
      setSessionBoth(stored);
      setStatus("authenticated");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  /* React to wallet connect / disconnect / account switch. Never runs
     before the restore above, so a page reload can't wipe a valid session
     before the wallet has had a chance to reconnect — that was the
     "asked to reconnect on every navigation" bug: the old code deleted
     the 7-day session whenever wallet.account was momentarily null. */
  useEffect(() => {
    if (!restoredRef.current) return;
    if (status === "loading" || status === "signing") return;
    const stored = sessionRef.current;
    if (!account) {
      // No wallet connected (yet). The 7-day session is a bearer token:
      // it stays valid without a live wallet connection and keeps
      // authenticating API calls. Keep it — only drop to anonymous when
      // there is no session at all.
      setStatus(stored && stored.chainId === chain.chainId ? "authenticated" : "anonymous");
      return;
    }
    const accountAddr = canonicalAddress(account);
    if (stored && stored.chainId === chain.chainId && accountAddr && stored.address === accountAddr) {
      setStatus("authenticated");
      return;
    }
    // A different wallet connected — the old session belongs to someone
    // else. (Explicit sign-out clears the session itself, so reaching
    // here with no stored session just means "connected, not signed in".)
    writeStored(null);
    setSessionBoth(null);
    setStatus("connected");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, status, chain.chainId]);

  /**
   * Hedera login via a wallet-signed transaction — the KISS Hedera method.
   *
   * `hedera_signMessage` is unreliable in some wallets (notably HashPack's
   * dapp browser): the prompt never appears and the request hangs until it
   * times out. But `hedera_signAndExecuteTransaction` provably works there
   * (tipping uses it every day). So the login challenge goes in a
   * transaction memo instead of a signed message: the wallet signs a
   * 1-tinybar self-transfer carrying
   * "VSLOGIN <account> <commit> <expiresAtMs> <origin>", and the server
   * verifies the confirmed transaction on the mirror node. No message
   * signing, no custom crypto — just a Hedera transaction and the mirror.
   *
   * Replay protection: the memo carries sha256(secret) (truncated), while
   * the secret itself travels only in the HTTPS POST body — the public
   * transaction id alone can't be replayed into a session.
   *
   * Costs the standard transaction fee (~$0.0001); the 1-tinybar transfer
   * itself moves nothing. Returns { loginTxId, secret }.
   */
  const signHederaLoginTx = useCallback(
    async (accountId: string): Promise<{ loginTxId: string; secret: string }> => {
      const pairing = getHederaPairing();
      if (!pairing) throw new Error("Wallet session not ready — reconnect and try again.");
      const { AccountId, Client, Hbar, TransactionId, TransferTransaction } =
        await import("@hiero-ledger/sdk");
      const chain = (await import("./chains")).getActiveChain();
      const network = chain.key === "hedera-mainnet" ? "mainnet" : "testnet";
      // Secret stays off-chain; only its hash goes in the public memo.
      const secret = generateNonce();
      const commit = (await sha256Hex(secret)).slice(0, 16);
      const expiresAtMs = Date.now() + SESSION_TTL_MS;
      // Login challenge in the memo (100-byte tx memo limit).
      const memo = `VSLOGIN ${accountId} ${commit} ${expiresAtMs} ${window.location.origin}`;
      if (memo.length > 100) throw new Error("Login challenge too long — try again.");

      const tx = new TransferTransaction()
        .addHbarTransfer(accountId, Hbar.fromTinybars(-1))
        .addHbarTransfer(accountId, Hbar.fromTinybars(1))
        .setTransactionMemo(memo);
      tx.setTransactionId(TransactionId.generate(AccountId.fromString(accountId)));
      tx.freezeWith(chain.key === "hedera-mainnet" ? Client.forMainnet() : Client.forTestnet());
      const txId = tx.transactionId?.toString() ?? "";
      const txBase64 = Buffer.from(tx.toBytes()).toString("base64");

      // Don't wait on the wallet response — it often gets lost in HashPack's
      // in-app browser. Send the tx, then watch the mirror for the approval.
      // The user approves in the wallet; we see it land and complete login.
      // This is the reliable path: the chain is the source of truth, not the
      // wallet's response callback.
      const walletSend = (
        pairing.hc.signAndExecuteTransaction as unknown as (
          params: object,
        ) => Promise<unknown>
      )({
        signerAccountId: `hedera:${network}:${accountId}`,
        transactionList: txBase64,
      });
      // A lost response just never settles; a real rejection (user hit
      // Reject) should surface instead of polling for 2 minutes.
      let walletRejected: unknown = null;
      walletSend.catch((e) => {
        walletRejected = e;
      });
      // Fast path: wallet returns the txId (works on desktop/good connections).
      const returned = await Promise.race([
        walletSend.then(() => txId as string | null).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
      ]);
      if (returned && (await checkLoginTxLanded(returned))) {
        return { loginTxId: returned, secret };
      }
      if (walletRejected) throw walletRejected;
      // Reliable path: poll the mirror for our login memo. The user has up
      // to 2 minutes to approve in the wallet.
      const deadline = Date.now() + 120_000;
      for (;;) {
        if (walletRejected) throw walletRejected;
        const found = await findLoginTxByMemo(accountId, commit);
        if (found) return { loginTxId: found, secret };
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 3_000));
      }
      throw new Error(
        "Didn't see your approval on-chain. Approve the transaction in your " +
          "wallet and try again.",
      );
    },
    [],
  );

  /** SHA-256 hex digest (WebCrypto). Used for the login memo commitment. */
  async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Mirror-node check: did our login transaction actually execute?
   * Recovery path for a wallet that goes silent after the user approves —
   * we generated the txId, so we can look it up directly.
   */
  async function checkLoginTxLanded(txId: string): Promise<boolean> {
    try {
      const { toMirrorTxId } = await import("./tx-confirm");
      const res = await fetch(
        `https://mainnet.mirrornode.hedera.com/api/v1/transactions/${encodeURIComponent(toMirrorTxId(txId))}`,
      );
      if (!res.ok) return false;
      const data = (await res.json()) as { transactions?: Array<{ result?: string }> };
      return data.transactions?.[0]?.result === "SUCCESS";
    } catch {
      return false;
    }
  }

  /**
   * Fallback for when the wallet submits the login tx but loses the response
   * (txId unknown). Searches the mirror for a recent successful transfer from
   * the account whose memo carries our login commitment.
   */
  async function findLoginTxByMemo(accountId: string, commit: string): Promise<string | null> {
    try {
      const res = await fetch(
        `https://mainnet.mirrornode.hedera.com/api/v1/transactions` +
          `?account.id=${encodeURIComponent(accountId)}` +
          `&transactiontype=cryptotransfer&limit=10&order=desc`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        transactions?: Array<{ transaction_id?: string; result?: string; memo_base64?: string }>;
      };
      for (const t of data.transactions ?? []) {
        if (t.result !== "SUCCESS" || !t.transaction_id || !t.memo_base64) continue;
        let memo = "";
        try {
          memo = Buffer.from(t.memo_base64, "base64").toString("utf8");
        } catch {
          continue;
        }
        if (memo.includes(commit)) return t.transaction_id;
      }
      return null;
    } catch {
      return null;
    }
  }

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
          // connect() throws with the specific failure reason on error,
          // so the catch block below will show the actual message.
          activeAccount = await wallet.connect(targetAdapter);
          activeAdapter = targetAdapter;
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

        let credential: { loginTxId: string; secret: string } | { message: string; signature: string };
        if (isHederaAccountId(activeAccount)) {
          // Hedera login = wallet-signed transaction (the KISS Hedera
          // method). The server verifies the confirmed transaction on the
          // mirror node and issues the session token.
          credential = await signHederaLoginTx(activeAccount);
        } else {
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
          const signature = await signEvmMessage(message, activeAccount);
          // Client-side check before we trust the session locally.
          if (!verifyEvmSignature(message, signature, activeAccount)) {
            throw new Error(
              "Signature verification failed — the wallet may have signed with a different account.",
            );
          }
          credential = { message, signature };
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
            body: JSON.stringify({ credential }),
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
        setSessionBoth(created);
        writeStored(created);
        setStatus("authenticated");
        return created;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Sign-in failed.";
        // User rejection shouldn't look like an app error.
        const rejected = /user (rejected|denied)|rejected the request/i.test(msg);
        // Stale WalletConnect session: the wallet never responded. Auto-
        // disconnect so the next attempt starts with a clean pairing instead
        // of reusing the broken one — the user shouldn't have to manually
        // nuke both apps.
        const staleSession = /stale|didn't respond/i.test(msg);
        if (staleSession) {
          try {
            await wallet.disconnect();
          } catch {
            // Best effort — the error message below is what matters.
          }
        }
        setError(rejected ? "Signature request was dismissed in the wallet." : msg);
        setSessionBoth(null);
        writeStored(null);
        setStatus(account && !staleSession ? "connected" : "anonymous");
        throw e instanceof Error ? e : new Error(msg);
      } finally {
        signingRef.current = false;
      }
    },
    [adapterId, account, chain.chainId, signEvmMessage, signHederaLoginTx, wallet],
  );

  const signOut = useCallback(() => {
    setSessionBoth(null);
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
  description = "Connect your wallet and approve the sign-in request to use this feature.",
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
export function SignInButton() {
  const { signIn, status, error } = useSession();
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
      {error && !busy && (
        <div
          role="alert"
          style={{
            marginTop: 8,
            padding: "8px 12px",
            borderRadius: 8,
            background: "rgba(255,80,80,0.12)",
            border: "1px solid rgba(255,80,80,0.4)",
            color: "#ff9a9a",
            fontSize: 13,
            maxWidth: 300,
          }}
        >
          {error}
        </div>
      )}
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
            background: "var(--vs-panel)",
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
