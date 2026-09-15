"use client";

/**
 * Halving countdowns — a slim informational strip under the Clarity Act
 * countdown. Brandon 2026-09-15: no ticking clock boxes; the dates are
 * what matter. Kept quiet so the landing flows.
 *
 * Bitcoin: block 1,050,000, est. Apr 2028 per CoinGecko.
 * Litecoin: block 3,360,000, est. ~Jul 2027.
 */
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { T } from "@/components/T";

/** Next Bitcoin halving: block 1,050,000, estimated 2028-04-17 (CoinGecko). */
export const BTC_HALVING_AT = "2028-04-17T00:00:00Z";
/** Next Litecoin halving: block 3,360,000, estimated ~2027-07-30. */
export const LTC_HALVING_AT = "2027-07-30T00:00:00Z";

function fmtMonthYear(iso: string, locale: string) {
  try {
    return new Date(iso).toLocaleDateString(locale, { month: "short", year: "numeric" });
  } catch {
    return "";
  }
}

export function HalvingCountdowns() {
  const { t, lang } = useLanguage();

  const items = [
    {
      symbol: "₿",
      color: "#f7931a",
      name: t("landing.halvingBtc"),
      meta: t("landing.halvingBtcMeta"),
      date: fmtMonthYear(BTC_HALVING_AT, lang),
    },
    {
      symbol: "Ł",
      color: "#8ba9d9",
      name: t("landing.halvingLtc"),
      meta: t("landing.halvingLtcMeta"),
      date: fmtMonthYear(LTC_HALVING_AT, lang),
    },
  ];

  return (
    <section className="vs-section" style={{ paddingTop: 0, paddingBottom: 36 }}>
      <div
        className="vs-glass"
        style={{
          padding: "16px 24px",
          border: "1px solid var(--vs-border)",
          display: "flex",
          flexWrap: "wrap",
          gap: "8px 32px",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        <p className="vs-label" style={{ margin: 0, width: "100%" }}>
          <span className="vs-live-dot" aria-hidden="true" /> <T k="landing.halvingLabel" />
        </p>
        {items.map((it) => (
          <p
            key={it.name}
            style={{ margin: 0, fontSize: 14, color: "var(--vs-muted)", lineHeight: 1.6 }}
          >
            <span
              style={{ color: it.color, fontWeight: 700, marginRight: 8 }}
              aria-hidden="true"
            >
              {it.symbol}
            </span>
            <strong style={{ fontWeight: 600 }}>{it.name}</strong> · {it.meta} ·{" "}
            {t("landing.halvingEstimated")} {it.date}
          </p>
        ))}
      </div>
    </section>
  );
}
