"use client";

/**
 * Clarity Act countdown — Senate procedural vote expected Sep 15, 2026.
 *
 * Gives the landing page a live, return-worthy beat: the biggest US crypto
 * legislation moment, counting down in real time. The target date is a
 * config constant — update it if Congress moves the vote.
 * Past the date → flips to a "vote week is here" state, never a negative timer.
 *
 * Presentation (2026-09-15 cleanup): a slim strip, not a second big
 * timer-card grid — the halving section below already owns the featured
 * countdown look, so this one stays visually quiet and distinct.
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
  // SSR / pre-hydration: render the countdown against the server clock so
  // the static shell never claims the vote is live before it is. The client
  // takes over on the next tick; a sub-second skew self-corrects.
  const p = partsLeft(target, now ?? Date.now());

  return (
    <section className="vs-section" style={{ paddingTop: 0, paddingBottom: 36 }}>
      <div
        className="vs-glass"
        style={{
          padding: "20px 24px",
          border: "1px solid var(--vs-border)",
          display: "flex",
          flexWrap: "wrap",
          gap: "8px 28px",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ flex: "1 1 320px", maxWidth: 560, minWidth: 240 }}>
          <p className="vs-label" style={{ marginBottom: 6 }}>
            <span className="vs-live-dot" aria-hidden="true" /> {t("landing.clarityLabel")}
          </p>
          <h2 style={{ fontSize: "1.25rem", margin: "0 0 6px" }}>
            {p.live ? t("landing.clarityLiveTitle") : t("landing.clarityTitle")}
          </h2>
          <p style={{ color: "var(--vs-muted)", fontSize: 14, margin: 0, lineHeight: 1.65 }}>
            {p.live ? t("landing.clarityLiveBody") : t("landing.clarityBody")}
          </p>
        </div>
        {!p.live && (
          <div
            className="vs-mono"
            role="timer"
            aria-label={t("landing.clarityLabel")}
            style={{
              fontSize: 19,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            {p.days} {t("landing.cdDays")} · {p.hours} {t("landing.cdHours")} ·{" "}
            {p.mins} {t("landing.cdMins")} · {p.secs} {t("landing.cdSecs")}
          </div>
        )}
      </div>
      <p
        style={{
          color: "var(--vs-muted)",
          fontSize: 13,
          margin: "14px 0 0",
          textAlign: "center",
        }}
      >
        {t("landing.clarityNote")}
      </p>
    </section>
  );
}
