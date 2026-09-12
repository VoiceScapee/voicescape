"use client";

import { useEffect, useState } from "react";

interface Tip {
  txHash: string;
  from: string;
  to: string;
  amountHbar: string;
  timestamp: string;
}

/**
 * Recent on-chain tip activity from the VoicescapeTips contract.
 * Real data from Hedera Mirror Node, newest first.
 */
export function RecentActivity() {
  const [tips, setTips] = useState<Tip[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/activity/recent")
      .then((res) => res.json())
      .then((data) => {
        setTips(data.tips || []);
      })
      .catch(() => {
        // Silently fail - activity feed is nice-to-have
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <p className="th-muted" style={{ fontSize: 13 }}>Loading recent activity…</p>;
  }

  if (tips.length === 0) {
    return null; // Don't show empty section
  }

  const shortAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

  return (
    <div style={{ marginTop: 32 }}>
      <h3 style={{ fontSize: 16, marginBottom: 12 }}>Recent Tips</h3>
      <div style={{ display: "grid", gap: 8 }}>
        {tips.map((tip) => (
          <a
            key={tip.txHash}
            href={`https://hashscan.io/mainnet/transaction/${tip.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="vs-card"
            style={{
              padding: "10px 14px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <span style={{ fontSize: 13 }}>
              <code>{shortAddr(tip.from)}</code>
              <span className="th-muted"> → </span>
              <code>{shortAddr(tip.to)}</code>
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--vs-accent)" }}>
              {tip.amountHbar} ℏ
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
