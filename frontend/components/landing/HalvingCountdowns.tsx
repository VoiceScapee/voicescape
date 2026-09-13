"use client";

/**
 * Halving countdowns — sits right under the Clarity Act countdown.
 *
 * Bitcoin (block 1,050,000, est. Apr 2028 per CoinGecko) and Litecoin
 * (block 3,360,000, est. ~Jul 2027) count down live, every second.
 * Dogecoin has NO halving — its reward is fixed at 10,000 DOGE per block
 * forever — so its card says exactly that instead of faking a countdown.
 */
import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { T } from "@/components/T";

/** Next Bitcoin halving: block 1,050,000, estimated 2028-04-17 (CoinGecko). */
export const BTC_HALVING_AT = "2028-04-17T00:00:00Z";
/** Next Litecoin halving: block 3,360,000, estimated ~2027-07-30. */
export const LTC_HALVING_AT = "2027-07-30T00:00:00Z";

function partsLeft(targetMs: number, nowMs: number) {
  const diff = Math.max(0, targetMs - nowMs);
  return {
    days: Math.floor(diff / 86_400_000),
    hours: Math.floor(diff / 3_600_000) % 24,
    mins: Math.floor(diff / 60_000) % 60,
    secs: Math.floor(diff / 1_000) % 60,
  };
}

function fmtMonthYear(iso: string, locale: string) {
  try {
    return new Date(iso).toLocaleDateString(locale, { month: "short", year: "numeric" });
  } catch {
    return "";
  }
}

function Units({ target, accent }: { target: number; accent: string }) {
  const { t } = useLanguage();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const p = partsLeft(target, now ?? Date.now());
  const units = [
    { v: p.days, label: t("landing.cdDays") },
    { v: p.hours, label: t("landing.cdHours") },
    { v: p.mins, label: t("landing.cdMins") },
    { v: p.secs, label: t("landing.cdSecs") },
  ];

  return (
    <div
      style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}
      role="timer"
    >
      {units.map((u) => (
        <div
          key={u.label}
          style={{
            minWidth: 84,
            padding: "12px 8px",
            borderRadius: 12,
            background: "var(--vs-bg2)",
            border: `1px solid ${accent}`,
          }}
        >
          <div className="vs-mono" style={{ fontSize: 28, fontWeight: 700 }}>
            {String(u.v).padStart(2, "0")}
          </div>
          <div style={{ fontSize: 12, color: "var(--vs-muted)", marginTop: 4 }}>{u.label}</div>
        </div>
      ))}
    </div>
  );
}

export function HalvingCountdowns() {
  const { t, lang } = useLanguage();
  const btcTarget = Date.parse(BTC_HALVING_AT);
  const ltcTarget = Date.parse(LTC_HALVING_AT);

  return (
    <section className="vs-section" style={{ paddingTop: 0 }}>
      <p className="vs-label" style={{ textAlign: "center" }}>
        <span className="vs-live-dot" aria-hidden="true" /> <T k="landing.halvingLabel" />
      </p>
      <h2
        style={{
          fontSize: "clamp(1.6rem, 4.5vw, 2.4rem)",
          margin: "12px 0 12px",
          textAlign: "center",
        }}
      >
        <T k="landing.halvingTitle" />
      </h2>
      <p
        style={{
          textAlign: "center",
          color: "var(--vs-muted)",
          fontSize: 16,
          maxWidth: 640,
          margin: "0 auto 28px",
          lineHeight: 1.7,
        }}
      >
        <T k="landing.halvingSub" />
      </p>

      {/* Bitcoin — the featured countdown */}
      <div
        className="vs-glass"
        style={{
          padding: "32px 24px",
          textAlign: "center",
          marginBottom: 16,
          border: "1px solid rgba(247,147,26,0.45)",
          boxShadow: "0 0 48px rgba(247,147,26,0.10)",
          background:
            "radial-gradient(ellipse 80% 100% at 50% 0%, rgba(247,147,26,0.08), transparent)",
        }}
      >
        <div style={{ fontSize: 40, color: "#f7931a", marginBottom: 4 }} aria-hidden="true">
          ₿
        </div>
        <h3 style={{ margin: "0 0 6px", fontSize: 22, color: "#f7931a" }}>
          <T k="landing.halvingBtc" />
        </h3>
        <p style={{ color: "var(--vs-muted)", fontSize: 14, margin: "0 0 20px" }}>
          <T k="landing.halvingBtcMeta" /> · {t("landing.halvingEstimated")}{" "}
          {fmtMonthYear(BTC_HALVING_AT, lang)}
        </p>
        <Units target={btcTarget} accent="rgba(247,147,26,0.35)" />
      </div>

      <div className="vs-grid-2">
        {/* Litecoin */}
        <div
          className="vs-card"
          style={{ textAlign: "center", border: "1px solid rgba(90,130,190,0.40)" }}
        >
          <div style={{ fontSize: 32, color: "#8ba9d9", marginBottom: 4 }} aria-hidden="true">
            Ł
          </div>
          <h3 style={{ margin: "0 0 6px", fontSize: 19, color: "#8ba9d9" }}>
            <T k="landing.halvingLtc" />
          </h3>
          <p style={{ color: "var(--vs-muted)", fontSize: 13, margin: "0 0 16px" }}>
            <T k="landing.halvingLtcMeta" /> · {t("landing.halvingEstimated")}{" "}
            {fmtMonthYear(LTC_HALVING_AT, lang)}
          </p>
          <Units target={ltcTarget} accent="rgba(90,130,190,0.35)" />
        </div>

        {/* Dogecoin — no halving exists, so no fake countdown */}
        <div
          className="vs-card"
          style={{ textAlign: "center", border: "1px solid rgba(194,166,51,0.40)" }}
        >
          <div style={{ fontSize: 32, color: "#d3bc5e", marginBottom: 4 }} aria-hidden="true">
            Ð
          </div>
          <h3 style={{ margin: "0 0 8px", fontSize: 19, color: "#d3bc5e" }}>
            <T k="landing.halvingDoge" />
          </h3>
          <p style={{ margin: "0 0 14px" }}>
            <span
              className="vs-badge"
              style={{
                background: "rgba(194,166,51,0.12)",
                color: "#d3bc5e",
                border: "1px solid rgba(194,166,51,0.35)",
              }}
            >
              <T k="landing.halvingDogeBadge" />
            </span>
          </p>
          <div className="vs-mono" style={{ fontSize: 28, fontWeight: 700 }}>
            10,000
          </div>
          <div style={{ fontSize: 12, color: "var(--vs-muted)", margin: "4px 0 12px" }}>
            <T k="landing.halvingDogePerBlock" />
          </div>
          <p style={{ color: "var(--vs-muted)", fontSize: 14, margin: 0, lineHeight: 1.7 }}>
            <T k="landing.halvingDogeNote" />
          </p>
        </div>
      </div>
    </section>
  );
}
