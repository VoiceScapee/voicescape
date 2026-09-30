"use client";

/**
 * Route-level error boundary — shown when a page crashes during render.
 *
 * Plain-words recovery UI: the user is never stranded on Next.js's generic
 * error page. "Try again" calls reset() to re-render the route. The crash
 * is reported to /api/client-error (best-effort, fail-silent) so the
 * founder dashboard sees render crashes too.
 */
import { useEffect } from "react";
import Link from "next/link";
import { reportError } from "@/lib/report-error";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportError(error, "error-boundary");
  }, [error]);

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "72px 20px", textAlign: "center" }}>
      <div style={{ fontSize: 44, marginBottom: 12 }}>😕</div>
      <h1 style={{ margin: "0 0 8px" }}>Something broke on this page</h1>
      <p className="th-muted" style={{ marginTop: 0 }}>
        The page hit an unexpected error. Your wallet and your blockpage are
        fine — this is on our side, and we&apos;ve logged it so we can fix it.
      </p>
      <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 20, flexWrap: "wrap" }}>
        <button type="button" className="vs-btn vs-btn-primary" onClick={reset}>
          Try again
        </button>
        <Link href="/" className="vs-btn vs-btn-ghost">
          ← Home
        </Link>
      </div>
      <p style={{ marginTop: 24 }}>
        <a
          href="https://discord.gg/2KGzPduUN5"
          target="_blank"
          rel="noopener noreferrer"
        >
          Need help? Get support on Discord →
        </a>
      </p>
    </div>
  );
}
