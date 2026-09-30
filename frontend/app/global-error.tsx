"use client";

/**
 * Root-layout error boundary — the last resort when even the root layout
 * fails. Next.js requires this file to define its own <html> and <body>;
 * it cannot use the app's providers, so it stays minimal and dependency-free
 * (no imports from @/lib — reporting here must not risk another crash).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
