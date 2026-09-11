"use client";

/**
 * Client-side providers mounted once at the root layout:
 * WalletProvider (connection) → SessionProvider (sign-in).
 *
 * Pages that previously wrapped themselves in their own WalletProvider keep
 * working — nested providers are harmless — but new code should rely on the
 * root providers and just call useWallet() / useSession().
 */

import React from "react";
import { WalletProvider } from "@/lib/wallet";
import { SessionProvider } from "@/lib/session";

/**
 * Recovers from stale-cache ChunkLoadErrors: if a Next.js chunk fails to
 * load (usually because the browser cached HTML from an old build), force
 * a hard reload with cache bypass instead of showing a broken page.
 * This is critical for HashPack's in-app browser which caches aggressively.
 */
function useChunkErrorRecovery() {
  React.useEffect(() => {
    const onError = (e: ErrorEvent) => {
      const msg = e.message || "";
      if (msg.includes("Loading chunk") && msg.includes("failed")) {
        // Prevent infinite reload loops: only retry once per session.
        if (!sessionStorage.getItem("vs-chunk-recovery")) {
          sessionStorage.setItem("vs-chunk-recovery", "1");
          window.location.reload();
        }
      }
    };
    // Also catch unhandled promise rejections (dynamic imports).
    const onRejection = (e: PromiseRejectionEvent) => {
      const msg = String(e.reason?.message || e.reason || "");
      if (msg.includes("Loading chunk") && msg.includes("failed")) {
        if (!sessionStorage.getItem("vs-chunk-recovery")) {
          sessionStorage.setItem("vs-chunk-recovery", "1");
          window.location.reload();
        }
      }
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
}

/**
 * Registers the PWA service worker (production only). The worker caches
 * static assets and page shells for installability/offline; it never
 * touches /api/* or cross-origin traffic.
 */
function useServiceWorker() {
  React.useEffect(() => {
    if (
      process.env.NODE_ENV === "production" &&
      typeof window !== "undefined" &&
      "serviceWorker" in navigator
    ) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* offline/installability is best-effort */
      });
    }
  }, []);
}

/**
 * Captures ?ref=<username> from the URL into localStorage so the referral
 * survives the signup flow (landing page → wallet connect → builder →
 * registration). The builder reads it back after successful on-chain
 * registration and records the referral server-side.
 */
function useReferralCapture() {
  React.useEffect(() => {
    try {
      const ref = new URLSearchParams(window.location.search).get("ref");
      if (ref && /^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/i.test(ref.trim())) {
        localStorage.setItem("vs_referral", ref.trim().toLowerCase());
      }
    } catch {
      /* storage unavailable — referral is best-effort */
    }
  }, []);
}

export function RootProviders({ children }: { children: React.ReactNode }) {
  useServiceWorker();
  useReferralCapture();
  useChunkErrorRecovery();
  return (
    <WalletProvider>
      <SessionProvider>{children}</SessionProvider>
    </WalletProvider>
  );
}
