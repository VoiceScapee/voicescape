"use client";

import { useEffect, useState } from "react";

interface Notification {
  txId: string;
  from: string;
  amountHbar: string;
  timestamp: string;
}

/**
 * Bell icon showing unread tip notifications.
 * Polls /api/notifications for TipSent events to the connected wallet.
 * Unread state tracked in localStorage by latest seen timestamp.
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

        const notifs = data.notifications || [];
        setNotifications(notifs);

        // Count unread: timestamps newer than last seen
        const lastSeen = localStorage.getItem(storageKey) || "0";
        const unreadCount = notifs.filter((n: Notification) => n.timestamp > lastSeen).length;
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
      const latest = notifications[0].timestamp;
      localStorage.setItem(storageKey, latest);
    }
    setUnread(0);
    setOpen(!open);
  };

  const shortAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

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
            width: 300,
            maxHeight: 400,
            overflowY: "auto",
            background: "var(--vs-bg)",
            border: "1px solid var(--vs-border)",
            borderRadius: 12,
            zIndex: 100,
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--vs-border)", fontWeight: 600, fontSize: 14 }}>
            Tips received
          </div>
          {notifications.length === 0 ? (
            <div style={{ padding: 16, fontSize: 13, color: "var(--vs-muted)", textAlign: "center" }}>
              No tips yet
            </div>
          ) : (
            notifications.map((n) => (
              <a
                key={n.txId}
                href={`https://hashscan.io/mainnet/transaction/${n.txId}`}
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
                  <code>{shortAddr(n.from)}</code>
                  <span style={{ fontWeight: 600, color: "var(--vs-accent)" }}>
                    {n.amountHbar} ℏ
                  </span>
                </div>
              </a>
            ))
          )}
        </div>
      )}
    </div>
  );
}
