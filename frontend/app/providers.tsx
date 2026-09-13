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
import { LanguageProvider } from "@/lib/i18n/LanguageContext";

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
    // Service worker disabled: it was causing stale chunk caching issues.
    // Unregister any existing service worker.
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => r.unregister());
      });
      // Clear all caches
      if ("caches" in window) {
        caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
      }
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

import { firstStackFrame } from "@/lib/client-error-frame";

/**
 * Privacy-first client error reporting.
 *
 * Listens for uncaught errors and unhandled promise rejections and sends
 * a minimal report to POST /api/client-error. What leaves the browser:
 *   - error.message only (max 200 chars, scrubbed of wallet addresses)
 *   - the FIRST stack frame only, scrubbed (function + chunk basename +
 *     line — enough to tell our code from a wallet dependency, e.g. for
 *     the `Cannot read properties of undefined (reading 'call')` class)
 *   - window.location.pathname (no query strings — they can carry PII)
 *   - an optional component tag
 * Never sent: full stack traces, full URLs/paths, IPs, user agents, wallet
 * addresses.
 *
 * Delivery is fire-and-forget via navigator.sendBeacon (works during page
 * unload), with a keepalive fetch fallback. Reporting never throws and
 * never retries: a failure to report is silently dropped so telemetry can
 * never cause an error loop. At most 10 unique reports per page load.
 */
function useClientErrorReporting() {
  React.useEffect(() => {
    const seen = new Set<string>();
    const scrub = (s: string): string =>
      s.replace(/0x[a-fA-F0-9]{8,}/g, "0x…").replace(/\b\d{1,10}\.\d{1,10}\.\d{1,10}\b/g, "0.0.…");

    const report = (message: string, component?: string, frame?: string | null) => {
      try {
        const msg = scrub(message).trim().replace(/\s+/g, " ").slice(0, 200);
        if (!msg) return;
        // Pathname only — strip query string and fragment (can carry PII).
        const page = (window.location.pathname || "/").split("?")[0].split("#")[0] || "/";
        const key = `${page}|${component ?? ""}|${msg}|${frame ?? ""}`;
        if (seen.has(key) || seen.size >= 10) return;
        seen.add(key);
        const payload = JSON.stringify({
          message: msg,
          page,
          ...(component ? { component } : {}),
          ...(frame ? { frame } : {}),
        });
        if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
          navigator.sendBeacon("/api/client-error", new Blob([payload], { type: "application/json" }));
        } else {
          void fetch("/api/client-error", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
            keepalive: true,
          }).catch(() => {
            /* telemetry failure is silently dropped */
          });
        }
      } catch {
        /* reporting must never throw */
      }
    };

    const onError = (e: ErrorEvent) => {
      // Message + first scrubbed stack frame — enough to attribute the
      // error to our code vs a wallet dependency.
      const err = (e as ErrorEvent & { error?: unknown }).error;
      const frame = err instanceof Error ? firstStackFrame(err.stack) : firstStackFrame((err as { stack?: unknown } | null)?.stack);
      report(typeof e.message === "string" && e.message ? e.message : "unknown error", undefined, frame);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r: unknown = e.reason;
      const msg =
        r instanceof Error && r.message
          ? r.message
          : typeof r === "string" && r
            ? r
            : "unhandled promise rejection";
      report(msg, undefined, r instanceof Error ? firstStackFrame(r.stack) : null);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
}

export function RootProviders({ children }: { children: React.ReactNode }) {
  useServiceWorker();
  useReferralCapture();
  useChunkErrorRecovery();
  useClientErrorReporting();
  return (
    <WalletProvider>
      <SessionProvider>
        <LanguageProvider>{children}</LanguageProvider>
      </SessionProvider>
    </WalletProvider>
  );
}
