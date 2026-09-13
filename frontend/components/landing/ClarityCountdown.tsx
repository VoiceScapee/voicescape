"use client";

/**
 * Clarity Act countdown — Senate procedural vote expected Sep 15, 2026.
 *
 * Gives the landing page a live, return-worthy beat: the biggest US crypto
 * legislation moment, counting down in real time. The target date is a
 * config constant — update it if Congress moves the vote.
 * Past the date → flips to a "vote week is here" state, never a negative timer.
 */
import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";

/**
 * Expected Senate procedural vote on the Digital Asset Market Clarity Act.
 *
 * Date-level precision on purpose: Reuters/CoinDesk report an expected vote
 * on Sep 15, 2026, but no exact time was published — so we count down to
 * the start of that day (ET) rather than inventing an hour.
 */
export const CLARITY_VOTE_AT = "2026-09-15T00:00:00-04:00";

function partsLeft(targetMs: number, nowMs: number) {
  const diff = Math.max(0, targetMs - nowMs);
  return {
    days: Math.floor(diff / 86_400_000),
    hours: Math.floor(diff / 3_600_000) % 24,
    mins: Math.floor(diff / 60_000) % 60,
    secs: Math.floor(diff / 1_000) % 60,
    live: diff <= 0,
  };
}

export function ClarityCountdown() {
  const { t } = useLanguage();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const target = Date.parse(CLARITY_VOTE_AT);
  // SSR / pre-hydration: render the static shell so layout never shifts.
  const p = partsLeft(target, now ?? target);

  const units: { v: number; label: string }[] = [
    { v: p.days, label: t("landing.cdDays") },
    { v: p.hours, label: t("landing.cdHours") },
    { v: p.mins, label: t("landing.cdMins") },
    { v: p.secs, label: t("landing.cdSecs") },
  ];

  return (
    <section className="vs-section" style={{ paddingTop: 0 }}>
      <div
        className="vs-glass"
        style={{
          padding: "28px 24px",
          textAlign: "center",
          border: "1px solid var(--vs-border)",
        }}
      >
        <p className="vs-label" style={{ marginBottom: 8 }}>
          <span className="vs-live-dot" aria-hidden="true" /> {t("landing.clarityLabel")}
        </p>
        <h2 style={{ fontSize: "clamp(1.3rem, 3.5vw, 1.8rem)", margin: "0 0 8px" }}>
          {p.live ? t("landing.clarityLiveTitle") : t("landing.clarityTitle")}
        </h2>
        <p style={{ color: "var(--vs-muted)", fontSize: 15, maxWidth: 620, margin: "0 auto 20px", lineHeight: 1.7 }}>
          {p.live ? t("landing.clarityLiveBody") : t("landing.clarityBody")}
        </p>
        {!p.live && (
          <div
            style={{
              display: "flex",
              gap: 12,
              justifyContent: "center",
              flexWrap: "wrap",
            }}
            role="timer"
            aria-label={t("landing.clarityLabel")}
          >
            {units.map((u) => (
              <div
                key={u.label}
                style={{
                  minWidth: 76,
                  padding: "12px 8px",
                  borderRadius: 12,
                  background: "var(--vs-bg2)",
                  border: "1px solid var(--vs-border)",
                }}
              >
                <div className="vs-mono" style={{ fontSize: 28, fontWeight: 700 }}>
                  {String(u.v).padStart(2, "0")}
                </div>
                <div style={{ fontSize: 12, color: "var(--vs-muted)", marginTop: 4 }}>{u.label}</div>
              </div>
            ))}
          </div>
        )}
        <p style={{ color: "var(--vs-muted)", fontSize: 13, margin: "16px 0 0" }}>
          {t("landing.clarityNote")}
        </p>
      </div>
    </section>
  );
}
