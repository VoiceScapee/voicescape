"use client";

/**
 * Slim date strip for the landing page: "TUESDAY, SEPTEMBER 15, 2026 ·
 * HEDERA MAINNET". Upper-cased via CSS; the date itself is the visitor's
 * local date (en-US format), rendered client-side.
 */
import { useLanguage } from "@/lib/i18n/LanguageContext";

export function DateStrip() {
  const { t } = useLanguage();
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return (
    <div
      className="vs-mono"
      aria-label={`${date} · ${t("landing.mainnetTag")}`}
      style={{
        fontSize: 11.5,
        color: "var(--vs-muted)",
        textAlign: "center",
        padding: "10px 16px 4px",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {date} {" · "} {t("landing.mainnetTag")}
    </div>
  );
}
