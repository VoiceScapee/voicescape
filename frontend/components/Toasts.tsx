"use client";

/**
 * <Toasts> — the global toast host. Mount once in the root layout; any
 * component pushes lifecycle updates through lib/toasts.
 *
 * Bottom-anchored above the tab bar (thumb-zone adjacent), safe-area
 * padded, auto-dismissing. Kinds encode meaning: amber pulse = pending,
 * mint = confirmed, rose = failed, violet = info. Custom SVG marks only —
 * no emojis.
 */
import { useEffect, useState } from "react";
import {
  subscribeToasts,
  dismissToast,
  type Toast,
  type ToastKind,
} from "@/lib/toasts";

const KIND_STYLE: Record<ToastKind, { dot: string; border: string }> = {
  pending: { dot: "#ffca72", border: "rgba(255,202,114,.45)" },
  success: { dot: "#5eead4", border: "rgba(94,234,212,.45)" },
  error: { dot: "#fb7185", border: "rgba(251,113,133,.45)" },
  info: { dot: "#c084fc", border: "rgba(192,132,252,.45)" },
};

function ToastCard({ toast }: { toast: Toast }) {
  const style = KIND_STYLE[toast.kind];
  const explorerUrl =
    toast.txId && toast.explorerBase
      ? `${toast.explorerBase.replace(/\/$/, "")}/transaction/${toast.txId}`
      : null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="vs-toast"
      style={{ borderColor: style.border }}
    >
      <span
        aria-hidden="true"
        className={`vs-toast-dot${toast.kind === "pending" ? " is-pulsing" : ""}`}
        style={{ background: style.dot, boxShadow: `0 0 8px ${style.dot}` }}
      />
      <div className="vs-toast-body">
        <b>{toast.title}</b>
        {toast.sub && <p>{toast.sub}</p>}
        {explorerUrl && (
          <a href={explorerUrl} target="_blank" rel="noreferrer">
            View on HashScan
          </a>
        )}
      </div>
      <button
        type="button"
        className="vs-toast-close"
        aria-label="Dismiss"
        onClick={() => dismissToast(toast.id)}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export default function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setToasts), []);
  if (toasts.length === 0) return null;
  return (
    <div className="vs-toast-stack" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}
