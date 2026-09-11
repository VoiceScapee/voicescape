"use client";

import { useEffect, useState } from "react";
import { getJson } from "@/lib/townhall";
import type { ReferralStatsView } from "@/lib/server/townhall/types";

/**
 * Referral dashboard for a Voicescape page. Shows the user's referral
 * link (share it anywhere — ?ref= survives the signup flow via
 * localStorage), a copy button, and live stats: total referrals + the
 * list of referred users. Referrers earn Connector → Networker →
 * Growth Engine → Viral badges automatically.
 */
export default function ReferralCard({ username }: { username: string }) {
  const [stats, setStats] = useState<ReferralStatsView | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    getJson<ReferralStatsView>(`/api/townhall/referrals?username=${encodeURIComponent(username)}`)
      .then((d) => {
        if (live) setStats(d);
      })
      .catch(() => {
        if (live) setStats({ username, totalReferrals: 0, referredUsernames: [] });
      });
    return () => {
      live = false;
    };
  }, [username]);

  const link =
    typeof window !== "undefined"
      ? `${window.location.origin}/?ref=${encodeURIComponent(username.toLowerCase())}`
      : `/?ref=${encodeURIComponent(username.toLowerCase())}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      window.prompt("Copy your referral link:", link);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="th-referral-card vs-card" style={{ marginTop: 12, padding: 14 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>🔗 Refer &amp; grow</div>
      <div className="th-muted" style={{ fontSize: 13, marginBottom: 10 }}>
        Share your link — when someone registers through it, you get credit
        and earn referral badges.
      </div>
      <div className="th-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <code
          className="vs-mono"
          style={{
            fontSize: 12,
            padding: "6px 10px",
            background: "rgba(255,255,255,0.06)",
            borderRadius: 8,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: "100%",
          }}
        >
          {link}
        </code>
        <button className="vs-btn vs-btn-ghost th-btn-sm" onClick={copy}>
          {copied ? "✓ Copied" : "Copy link"}
        </button>
      </div>
      <div className="th-row" style={{ gap: 16, marginTop: 10, fontSize: 13 }}>
        <span>
          <strong>{stats ? stats.totalReferrals : "…"}</strong>{" "}
          <span className="th-muted">referral{stats && stats.totalReferrals === 1 ? "" : "s"}</span>
        </span>
      </div>
      {stats && stats.referredUsernames.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 13 }}>
          <span className="th-muted">You brought in: </span>
          {stats.referredUsernames.map((u, i) => (
            <span key={u}>
              <a href={`/${encodeURIComponent(u)}`} className="vs-link">
                @{u}
              </a>
              {i < stats.referredUsernames.length - 1 ? ", " : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
