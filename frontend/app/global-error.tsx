"use client";

/**
 * Root-layout error boundary — the last resort when even the root layout
 * fails. Next.js requires this file to define its own <html> and <body>;
 * it cannot use the app's providers, so it stays minimal and dependency-free
 * (no imports from @/lib — reporting here must not risk another crash).
 *
 * The crash IS still reported to /api/client-error, via an inline
 * zero-dependency sendBeacon below (no @/lib imports — only React and
 * browser builtins). Root-layout crashes are the most severe client
 * failures; leaving them invisible was a blind spot.
 */
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    try {
      // Inline, dependency-free, privacy-safe report. Mirrors the rules in
      // lib/report-error.ts without importing it: message only (scrubbed of
      // anything shaped like a wallet address / account ID), pathname only,
      // component tag, error name, Next.js digest for correlation.
      // sendBeacon is fire-and-forget so telemetry can never break this
      // last-resort UI, and the whole block is wrapped so reporting can
      // never throw into the boundary.
      const rawMsg =
        (error && typeof error.message === "string" && error.message) || "root layout crash";
      const msg = rawMsg
        .replace(/0x[a-fA-F0-9]{8,}/g, "0x…")
        .replace(/\b\d{1,10}\.\d{1,10}\.\d{1,10}\b/g, "0.0.…")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 200);
      if (!msg || typeof window === "undefined") return;
      const page = (window.location.pathname || "/").split("?")[0].split("#")[0] || "/";
      const digest =
        error && typeof error.digest === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(error.digest)
          ? error.digest
          : null;
      const payload = JSON.stringify({
        message: digest ? `${msg} (digest ${digest})` : msg,
        page,
        component: "global-error-boundary",
        ...(error && error.name ? { name: String(error.name).slice(0, 40) } : {}),
      });
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon("/api/client-error", new Blob([payload], { type: "application/json" }));
      }
    } catch {
      /* reporting must never break the last-resort UI */
    }
  }, [error]);
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, sans-serif",
          background: "#0b0b10",
          color: "#f3f3f5",
        }}
      >
        <div style={{ maxWidth: 560, margin: "0 auto", padding: "72px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>😕</div>
          <h1 style={{ margin: "0 0 8px" }}>Voicescape hit a problem</h1>
          <p style={{ color: "#9a9aa5", marginTop: 0 }}>
            The app failed to start properly. Reloading usually fixes it —
            your wallet and your blockpage are safe.
            {error?.digest ? ` (ref ${error.digest})` : ""}
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 20, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={reset}
              style={{
                padding: "12px 24px",
                borderRadius: 12,
                border: "none",
                background: "#7c5cff",
                color: "#fff",
                fontSize: 16,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: "12px 24px",
                borderRadius: 12,
                border: "1px solid #3a3a45",
                background: "transparent",
                color: "#f3f3f5",
                fontSize: 16,
                cursor: "pointer",
              }}
            >
              Reload the app
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
