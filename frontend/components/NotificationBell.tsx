"use client";

import { useEffect, useState } from "react";
import { DigestCard } from "./DigestCard";
import type { NotifType } from "@/lib/notify-types";

type TipNotification = {
  type?: "tip";
  txId: string;
  from: string;
  amountHbar: string;
  timestamp: string;
};

type SocialNotification = {
  type: Exclude<NotifType, "tip">;
  id: string;
  tsMs: number;
  actor: string;
  title: string;
  body: string;
  url: string;
};

type Notification = TipNotification | SocialNotification;

const TYPE_META: Record<Exclude<NotifType, "tip">, { icon: string }> = {
  reply: { icon: "💬" },
  mention: { icon: "@" },
  follow: { icon: "➕" },
  sale: { icon: "🛒" },
};

/** Epoch ms for any notification row (tips carry mirror-node timestamp strings). */
function tsMsOf(n: Notification): number {
  if (typeof (n as SocialNotification).tsMs === "number") {
    return (n as SocialNotification).tsMs;
  }
  return Math.round(parseFloat((n as TipNotification).timestamp ?? "0") * 1000);
}

/**
 * Bell icon showing unread notifications.
 * Polls /api/notifications for the connected wallet: TipSent events plus
 * social events (replies, mentions, follows, marketplace sales).
 * Unread state tracked in localStorage by latest seen timestamp (epoch ms).
 * A "While you were away" digest card renders at the top of the dropdown.
 */
export function NotificationBell({ address }: { address: string }) {
  // Normalize to EVM format (0x...) for the API
  const evmAddress = (() => {
    const m = /^0\.0\.(\d+)$/.exec(address.trim());
    if (m) {
      try {
        return ("0x" + BigInt(m[1]).toString(16).padStart(40, "0")).toLowerCase();
      } catch {
        return null;
      }
    }
    return /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : null;
  })();

  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  const storageKey = `vs-notif-seen-${evmAddress}`;

  useEffect(() => {
    if (!evmAddress) return;
    let cancelled = false;

    const fetchNotifs = async () => {
      try {
        const res = await fetch(`/api/notifications?address=${evmAddress}`);
        const data = await res.json();
        if (cancelled) return;

        const notifs = (data.notifications || []) as Notification[];
        setNotifications(notifs);

        // Count unread: timestamps newer than last seen (stored as epoch
        // ms; legacy values stored as mirror-node seconds are converted).
        let lastSeenMs = 0;
        try {
          const raw = localStorage.getItem(storageKey) ?? "0";
          const n = Number(raw);
          lastSeenMs = Number.isFinite(n) ? (raw.includes(".") && n < 1e13 ? n * 1000 : n) : 0;
        } catch {
          lastSeenMs = 0;
        }
        const unreadCount = notifs.filter((n) => tsMsOf(n) > lastSeenMs).length;
        setUnread(unreadCount);
      } catch {
        // Silently fail
      }
    };

    fetchNotifs();
    const interval = setInterval(fetchNotifs, 60000); // Poll every minute
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [evmAddress, storageKey]);

  if (!evmAddress) return null;

  const markRead = () => {
    if (notifications.length > 0) {
      const latest = Math.max(...notifications.map(tsMsOf));
      try {
        localStorage.setItem(storageKey, String(latest));
      } catch {
        /* private-mode — badge just stays */
      }
    }
    setUnread(0);
    setOpen(!open);
  };

  const shortAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

  const renderRow = (n: Notification) => {
    const type = ((n as SocialNotification).type ?? "tip") as NotifType;
    if (type === "tip") {
      const t = n as TipNotification;
      return (
        <a
          key={t.txId}
          href={`https://hashscan.io/mainnet/transaction/${t.txId}`}
          target="_blank"
          rel="noreferrer"
          style={{
            display: "block",
            padding: "10px 16px",
            borderBottom: "1px solid var(--vs-border)",
            textDecoration: "none",
            color: "inherit",
            fontSize: 13,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>
              <span style={{ marginRight: 6 }}>💸</span>
              <code>{shortAddr(t.from)}</code>
            </span>
            <span style={{ fontWeight: 600, color: "var(--vs-accent)" }}>
              {t.amountHbar} ℏ
            </span>
          </div>
        </a>
      );
    }
    const s = n as SocialNotification;
    return (
      <a
        key={s.id}
        href={s.url}
        style={{
          display: "block",
          padding: "10px 16px",
          borderBottom: "1px solid var(--vs-border)",
          textDecoration: "none",
          color: "inherit",
          fontSize: 13,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 2 }}>
          <span style={{ marginRight: 6 }}>{TYPE_META[s.type].icon}</span>
          {s.title}
        </div>
        <div style={{ color: "var(--vs-muted)" }}>{s.body}</div>
      </a>
    );
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={markRead}
        aria-label="Notifications"
        style={{
          background: "var(--vs-glass)",
          border: "1px solid var(--vs-border)",
          borderRadius: 999,
          padding: "6px 10px",
          fontSize: 16,
          cursor: "pointer",
          color: "var(--vs-text)",
          position: "relative",
        }}
      >
        🔔
        {unread > 0 && (
          <span
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              background: "#ef4444",
              color: "white",
              borderRadius: 999,
              fontSize: 10,
              minWidth: 18,
              height: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
            }}
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: 8,
            width: "min(340px, calc(100vw - 32px))",
            maxHeight: 480,
            overflowY: "auto",
            background: "var(--vs-bg)",
            border: "1px solid var(--vs-border)",
            borderRadius: 12,
            zIndex: 100,
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          }}
        >
          <DigestCard address={evmAddress} />
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--vs-border)", fontWeight: 600, fontSize: 14 }}>
            Notifications
          </div>
          {notifications.length === 0 ? (
            <div style={{ padding: 16, fontSize: 13, color: "var(--vs-muted)", textAlign: "center" }}>
              Nothing yet — tips, replies, mentions, follows and sales will show up here
            </div>
          ) : (
            notifications.map(renderRow)
          )}
        </div>
      )}
    </div>
  );
}
