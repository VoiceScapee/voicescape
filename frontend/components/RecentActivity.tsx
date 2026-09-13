"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLanguage } from "@/lib/i18n/LanguageContext";

interface Tip {
  txHash: string;
  from: string;
  to: string;
  fromUsername: string | null;
  toUsername: string | null;
  amountHbar: string;
  /** Mirror-node timestamp: "seconds.nanoseconds". */
  timestamp: string;
}

/**
 * Recent on-chain tip activity from the VoicescapeTips contract.
 * Real data from Hedera Mirror Node (via /api/activity/recent),
 * newest first. Each row links the receipt on HashScan.
 */
export function RecentActivity() {
  const { t } = useLanguage();
  const [tips, setTips] = useState<Tip[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/activity/recent")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setTips(data.tips || []);
      })
      .catch(() => {
        if (!cancelled) setTips([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const shortAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

  const timeAgo = (ts: string): string => {
    const [secPart] = ts.split(".");
    const tipSec = Number(secPart);
    const diffSec = Number.isFinite(tipSec)
      ? Math.max(0, Math.floor(Date.now() / 1000 - tipSec))
      : 0;
    if (diffSec < 60) return t("activity.timeJustNow");
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return t("activity.timeMinAgo").replace("{n}", String(mins));
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t("activity.timeHourAgo").replace("{n}", String(hours));
    const days = Math.floor(hours / 24);
    return t("activity.timeDayAgo").replace("{n}", String(days));
  };

  const party = (addr: string, username: string | null) =>
    username ? (
      <Link href={`/${username}`} style={{ fontWeight: 600, textDecoration: "none" }}>
        @{username}
      </Link>
    ) : (
      <code>{shortAddr(addr)}</code>
    );

  return (
    <section id="activity" aria-label={t("activity.title")} style={{ scrollMarginTop: 96 }}>
      <h2 style={{ fontSize: "1.3rem", marginBottom: 4 }}>{t("activity.title")}</h2>
      <p style={{ color: "var(--vs-muted)", fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
        {t("activity.subtitle")}
      </p>

      {tips === null ? (
        <p style={{ color: "var(--vs-muted)", fontSize: 14 }}>{t("activity.loading")}</p>
      ) : tips.length === 0 ? (
        <div
          className="vs-glass"
          style={{
            padding: 28,
            borderRadius: 12,
            textAlign: "center",
            color: "var(--vs-muted)",
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          {t("activity.empty")}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {tips.map((tip) => (
            <div
              key={tip.txHash}
              className="vs-glass"
              style={{
                padding: "10px 14px",
                borderRadius: 12,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 13 }}>
                {party(tip.from, tip.fromUsername)}
                <span className="th-muted" aria-hidden="true">
                  {" "}
                  →{" "}
                </span>
                {party(tip.to, tip.toUsername)}
              </span>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 13,
                  marginLeft: "auto",
                }}
              >
                <span style={{ fontWeight: 700, color: "var(--vs-accent)" }}>
                  {tip.amountHbar} ℏ
                </span>
                <span style={{ color: "var(--vs-muted)", fontSize: 12 }}>
                  {timeAgo(tip.timestamp)}
                </span>
                <a
                  href={`https://hashscan.io/mainnet/transaction/${tip.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  title={t("activity.viewOnHashScan")}
                  aria-label={t("activity.viewOnHashScan")}
                  style={{ fontSize: 12, textDecoration: "none" }}
                >
                  ↗
                </a>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
