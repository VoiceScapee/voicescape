"use client";

import { useEffect, useState } from "react";

interface TrendingPage {
  address: string;
  totalHbar: string;
  tipCount: number;
  score: number;
}

/**
 * Trending feed — pages ranked by recent on-chain tip activity.
 * Algorithmic: score = total HBAR × (1 + log(tip count)).
 */
export function TrendingFeed() {
  const [trending, setTrending] = useState<TrendingPage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/trending")
      .then((r) => r.json())
      .then((d) => {
        setTrending(d.trending ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const shortAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

  if (loading) {
    return <p style={{ color: "var(--vs-muted)", fontSize: 14 }}>Loading trending…</p>;
  }

  if (trending.length === 0) {
    return null;
  }

  return (
    <section style={{ marginBottom: 40 }}>
      <h2 style={{ fontSize: "1.3rem", marginBottom: 4 }}>🔥 Trending</h2>
      <p style={{ color: "var(--vs-muted)", fontSize: 13, marginBottom: 16 }}>
        Most tipped pages this week, ranked by on-chain activity.
      </p>

      <div style={{ display: "grid", gap: 10 }}>
        {trending.map((t, i) => (
          <div
            key={t.address}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 16px",
              border: "1px solid var(--vs-border)",
              borderRadius: 12,
              background: "var(--vs-glass)",
            }}
          >
            <span
              style={{
                fontSize: 20,
                fontWeight: 800,
                color: i < 3 ? "var(--vs-accent)" : "var(--vs-muted)",
                minWidth: 28,
              }}
            >
              {i + 1}
            </span>
            <div style={{ flex: 1 }}>
              <code style={{ fontSize: 14 }}>{shortAddr(t.address)}</code>
              <div style={{ fontSize: 12, color: "var(--vs-muted)", marginTop: 2 }}>
                {t.tipCount} tip{t.tipCount !== 1 ? "s" : ""}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontWeight: 700, color: "var(--vs-accent)" }}>
                {t.totalHbar} ℏ
              </div>
              <div style={{ fontSize: 11, color: "var(--vs-muted)" }}>total tipped</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
