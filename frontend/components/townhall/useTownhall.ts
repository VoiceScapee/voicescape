"use client";

/**
 * Town Hall React hooks: page-identity (author/voter identity = the
 * connected wallet's page username, remembered in localStorage) and the
 * reusable dust-fee flow (useDustFee).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DustFeeRequired, sendDustFeeTo } from "@/lib/townhall";
import { useSession } from "@/lib/session";
import { useWallet } from "@/lib/wallet";
import { deriveUsername, deriveUsernameFromEvm } from "@/lib/identity";

const IDENTITY_KEY = "vs-townhall-username";

/**
 * The connected wallet's page username — the author/voter identity for
 * forum posts, chat, proposals and reputation votes. Stored in
 * localStorage; when empty the UI prompts the user to enter their
 * registered page username (or visit /builder to create one).
 */
export function usePageIdentity() {
  const [username, setUsernameState] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // KISS: default to the wallet-derived username so users can post
  // immediately without manually entering a name.
  let walletAccount: string | null = null;
  try {
    walletAccount = useWallet().account ?? null;
  } catch {
    walletAccount = null;
  }

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(IDENTITY_KEY);
      if (saved) {
        setUsernameState(saved);
      } else if (walletAccount) {
        // No saved username — use the wallet-derived one.
        const derived = deriveUsername(walletAccount) ?? deriveUsernameFromEvm(walletAccount);
        if (derived) {
          setUsernameState(derived);
          window.localStorage.setItem(IDENTITY_KEY, derived);
        }
      }
    } catch {
      // Storage unavailable — identity stays unset.
    }
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAccount]);

  const setUsername = useCallback((raw: string) => {
    const clean = raw.trim().replace(/^@+/, "").toLowerCase();
    setUsernameState(clean || null);
    try {
      if (clean) window.localStorage.setItem(IDENTITY_KEY, clean);
      else window.localStorage.removeItem(IDENTITY_KEY);
    } catch {
      // Best effort.
    }
  }, []);

  return { username, loaded, setUsername };
}

/**
 * Write gating for Town Hall actions (posts, chat, votes, proposals,
 * listings, events). A write is allowed only when the wallet is signed in
 * (active session) AND a page username is set — the server verifies the
 * session signature and that the wallet owns the claimed username.
 */
export function useWriteGate() {
  const { username, loaded, setUsername } = usePageIdentity();
  const { isAuthenticated, status } = useSession();
  const sessionReady = status !== "loading";
  const canWrite = sessionReady && isAuthenticated && !!username;
  return { username, loaded, setUsername, isAuthenticated, sessionReady, canWrite };
}

/* ------------------------------------------------------------------ */

export type DustPhase =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "fee"; tinybars: number; treasury: string }
  | { kind: "paying" }
  | { kind: "error"; message: string };

export interface DustFeeFlow {
  phase: DustPhase;
  /**
   * Run an attempt. The attempt receives an optional dustFeeTxId and must
   * throw DustFeeRequired (via postJson) when the server answers 402.
   * Resolves true when the attempt succeeded (fee paid if needed).
   */
  execute: (attempt: (dustFeeTxId?: string) => Promise<void>) => Promise<boolean>;
  /** Pay the pending dust fee from the connected wallet, then retry. */
  payFee: () => Promise<boolean>;
  reset: () => void;
}

/**
 * Reusable dust-fee flow for posts / chat / listings / proposals.
 *
 * Usage:
 *   const dust = useDustFee();
 *   await dust.execute(async (dustFeeTxId) => {
 *     await postJson("/api/townhall/posts", { board, body, author, dustFeeTxId });
 *   });
 *   // then render <DustFeeGate flow={dust} actionLabel="post" />
 */
export function useDustFee(): DustFeeFlow {
  const [phase, setPhase] = useState<DustPhase>({ kind: "idle" });
  const phaseRef = useRef<DustPhase>({ kind: "idle" });
  const attemptRef = useRef<((dustFeeTxId?: string) => Promise<void>) | null>(null);

  const set = useCallback((p: DustPhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const execute = useCallback(
    async (attempt: (dustFeeTxId?: string) => Promise<void>): Promise<boolean> => {
      attemptRef.current = attempt;
      set({ kind: "working" });
      try {
        await attempt(undefined);
        set({ kind: "idle" });
        return true;
      } catch (e) {
        if (e instanceof DustFeeRequired) {
          set({ kind: "fee", tinybars: e.dustFeeTinybars, treasury: e.treasury });
          return false;
        }
        set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        return false;
      }
    },
    [set],
  );

  const payFee = useCallback(async (): Promise<boolean> => {
    const p = phaseRef.current;
    const attempt = attemptRef.current;
    if (p.kind !== "fee" || !attempt) return false;
    set({ kind: "paying" });
    try {
      const txId = await sendDustFeeTo(p.treasury, BigInt(Math.round(p.tinybars)));
      await attempt(txId);
      set({ kind: "idle" });
      return true;
    } catch (e) {
      set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }, [set]);

  const reset = useCallback(() => set({ kind: "idle" }), [set]);

  return { phase, execute, payFee, reset };
}
