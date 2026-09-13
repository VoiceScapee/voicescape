"use client";

/**
 * RegulatoryCountdown — the landing page's live regulatory beat.
 *
 * Replaces the single Clarity Act countdown with an auto-advancing sequence
 * (see lib/landing/regulatory-beats.ts): Clarity vote → SEC 24-hour trading
 * roundtable → (CFTC next). Ticks every second; a passed beat hands off to
 * the next one on the next tick with no deploy in between. Never renders a
 * negative timer — past the final beat it holds that beat's "live" state.
 */
import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import type { I18nKey } from "@/lib/i18n/dictionaries";
import { REGULATORY_BEATS, activeBeat } from "@/lib/landing/regulatory-beats";

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

export function RegulatoryCountdown() {
  const { t } = useLanguage();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // SSR / pre-hydration: render against the server clock so the static shell
  // never claims a beat is live before it is. The client takes over on the
  // next tick; a sub-second skew self-corrects.
  const nowMs = now ?? Date.now();
  const beat = activeBeat(REGULATORY_BEATS, nowMs);
  const target = Date.parse(beat.targetAt);
  const p = partsLeft(target, nowMs);
  const k = (suffix: string) => `${beat.i18nPrefix}${suffix}` as I18nKey;

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
          <span className="vs-live-dot" aria-hidden="true" /> {t(k("Label"))}
        </p>
        <h2 style={{ fontSize: "clamp(1.3rem, 3.5vw, 1.8rem)", margin: "0 0 8px" }}>
          {p.live ? t(k("LiveTitle")) : t(k("Title"))}
        </h2>
        <p style={{ color: "var(--vs-muted)", fontSize: 15, maxWidth: 620, margin: "0 auto 20px", lineHeight: 1.7 }}>
          {p.live ? t(k("LiveBody")) : t(k("Body"))}
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
            aria-label={t(k("Label"))}
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
          {t(k("Note"))}
        </p>
      </div>
    </section>
  );
}
