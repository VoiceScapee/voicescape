"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLanguage } from "@/lib/i18n/LanguageContext";

interface Leader {
  rank: number;
  recipient: string;
  username: string | null;
  ownerType: "human" | "agent" | "unknown";
  totalHbar: string;
  tipCount: number;
  uniqueTippers: number;
}

/**
 * Weekly top-tipped creators leaderboard — "Most tipped this week".
 * Real on-chain data from /api/leaderboard/weekly (TipSent logs, last
 * 7 days), human creators only (agent pages are filtered server-side).
 * Not a "trending" feed: the ranking is plain total-HBAR order, stated
 * as such in the subtitle.
 */
export function WeeklyLeaderboard() {
  const { t } = useLanguage();
  const [leaders, setLeaders] = useState<Leader[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/leaderboard/weekly")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setLeaders(d.leaders ?? []);
      })
      .catch(() => {
        if (!cancelled) setLeaders([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const shortAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  const tipCountText = (n: number) =>
    t(n === 1 ? "leaderboard.tipCountSingular" : "leaderboard.tipCountPlural").replace(
      "{n}",
      String(n),
    );

  return (
    <section
      id="leaderboard"
      aria-label={t("leaderboard.title")}
      style={{ marginBottom: 40, scrollMarginTop: 96 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 4,
        }}
      >
        <h2 style={{ fontSize: "1.3rem", margin: 0 }}>{t("leaderboard.title")}</h2>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            padding: "4px 10px",
            borderRadius: 999,
            border: "1px solid var(--vs-border)",
            background: "var(--vs-glass)",
            color: "var(--vs-muted)",
          }}
        >
          {t("leaderboard.humansOnly")}
        </span>
      </div>
      <p style={{ color: "var(--vs-muted)", fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
        {t("leaderboard.subtitle")}
      </p>

      {leaders === null ? (
        <p style={{ color: "var(--vs-muted)", fontSize: 14 }}>{t("leaderboard.loading")}</p>
      ) : leaders.length === 0 ? (
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
          {t("leaderboard.empty")}
        </div>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
          {leaders.map((l) => (
            <li
              key={l.recipient}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 16px",
                border: "1px solid var(--vs-border)",
                borderRadius: 12,
                background: "var(--vs-glass)",
                flexWrap: "wrap",
              }}
            >
              <span
                aria-label={`${t("leaderboard.rank")} ${l.rank}`}
                style={{
                  fontSize: 20,
                  fontWeight: 800,
                  color: l.rank <= 3 ? "var(--vs-accent)" : "var(--vs-muted)",
                  minWidth: 32,
                }}
              >
                {l.rank}
              </span>
              <div style={{ flex: 1, minWidth: 140 }}>
                {l.username ? (
                  <Link
                    href={`/${l.username}`}
                    style={{ fontSize: 15, fontWeight: 700, textDecoration: "none" }}
                  >
                    @{l.username}
                  </Link>
                ) : (
                  <code style={{ fontSize: 14 }}>{shortAddr(l.recipient)}</code>
                )}
                <div style={{ fontSize: 12, color: "var(--vs-muted)", marginTop: 2 }}>
                  {tipCountText(l.tipCount)}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontWeight: 700, color: "var(--vs-accent)", fontSize: 15 }}>
                  {l.totalHbar} ℏ
                </div>
                <div style={{ fontSize: 11, color: "var(--vs-muted)" }}>{t("leaderboard.total")}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
