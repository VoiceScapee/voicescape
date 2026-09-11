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
  return (
    <WalletProvider>
      <SessionProvider>{children}</SessionProvider>
    </WalletProvider>
  );
}
