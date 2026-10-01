"use client";

import { useCallback, useEffect, useState } from "react";
import type { DigestItem, NotifType } from "@/lib/notify-types";

/**
 * "While you were away" card — the human return loop made visible.
 *
 * Fetches GET /api/digest?address=&since= where `since` is a
 * client-supplied watermark kept in localStorage (the server stores no
 * visit history — privacy rule). Shows counts per type plus the latest
 * few items, then offers "Mark as seen" to advance the watermark.
 *
 * Rendered at the top of the NotificationBell dropdown. Mobile-first:
 * full-width, wrapping rows, large tap targets.
 */

const TYPE_META: Record<NotifType, { icon: string; label: string }> = {
  tip: { icon: "💸", label: "tips" },
  reply: { icon: "💬", label: "replies" },
  mention: { icon: "@", label: "mentions" },
  follow: { icon: "➕", label: "new followers" },
  sale: { icon: "🛒", label: "sales" },
};

const ORDER: NotifType[] = ["reply", "mention", "follow", "sale", "tip"];

function timeAgo(tsMs: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - tsMs) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function DigestCard({ address }: { address: string }) {
  const storageKey = `vs-digest-seen-${address}`;
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "ready"; counts: Record<NotifType, number>; items: DigestItem[]; seen: boolean }
  >({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      let since = "0";
      try {
        since = localStorage.getItem(storageKey) ?? String(Date.now() - 24 * 3600 * 1000);
      } catch {
        since = String(Date.now() - 24 * 3600 * 1000);
      }
      const res = await fetch(
        `/api/digest?address=${encodeURIComponent(address)}&since=${encodeURIComponent(since)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`digest responded ${res.status}`);
      const json = (await res.json()) as {
        counts?: Record<NotifType, number>;
        items?: DigestItem[];
      };
      setState({
        status: "ready",
        counts: json.counts ?? { tip: 0, reply: 0, mention: 0, follow: 0, sale: 0 },
        items: Array.isArray(json.items) ? json.items : [],
        seen: false,
      });
    } catch {
      setState({ status: "error" });
    }
  }, [address, storageKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const markSeen = useCallback(() => {
    try {
      localStorage.setItem(storageKey, String(Date.now()));
    } catch {
      /* private-mode — the card just stays */
    }
    setState((s) => (s.status === "ready" ? { ...s, seen: true } : s));
  }, [storageKey]);

  if (state.status === "loading" || state.status === "error") return null;
  if (state.seen) return null;

  const total = ORDER.reduce((n, t) => n + (state.counts[t] ?? 0), 0);

  return (
    <div
      style={{
        margin: 12,
        padding: 12,
        borderRadius: 12,
        border: "1px solid var(--vs-border)",
        background: "var(--vs-glass)",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
        While you were away
      </div>
      {total === 0 ? (
        <div style={{ fontSize: 13, color: "var(--vs-muted)" }}>
          Nothing new since your last visit.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {ORDER.filter((t) => (state.counts[t] ?? 0) > 0).map((t) => (
              <span
                key={t}
                style={{
                  fontSize: 12,
                  padding: "3px 10px",
                  borderRadius: 999,
                  border: "1px solid var(--vs-border)",
                  color: "var(--vs-text)",
                  whiteSpace: "nowrap",
                }}
              >
                {TYPE_META[t].icon} {state.counts[t]} {TYPE_META[t].label}
              </span>
            ))}
          </div>
          <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
            {state.items.slice(0, 3).map((item) => (
              <a
                key={item.id}
                href={item.url}
                style={{
                  display: "block",
                  fontSize: 13,
                  color: "var(--vs-text)",
                  textDecoration: "none",
                  padding: "6px 8px",
                  borderRadius: 8,
                  background: "rgba(255,255,255,0.03)",
                }}
              >
                <span style={{ marginRight: 6 }}>{TYPE_META[item.type].icon}</span>
                <strong>{item.title}</strong>
                <span style={{ color: "var(--vs-muted)" }}> — {item.body}</span>
                <span style={{ color: "var(--vs-muted)", fontSize: 12, marginLeft: 6 }}>
                  {timeAgo(item.tsMs)}
                </span>
              </a>
            ))}
          </div>
        </>
      )}
      <button
        onClick={markSeen}
        className="vs-btn vs-btn-ghost"
        style={{ width: "100%", padding: "8px 0", fontSize: 13 }}
      >
        Mark as seen
      </button>
    </div>
  );
}
