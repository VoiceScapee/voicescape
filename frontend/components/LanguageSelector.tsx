"use client";

/**
 * LanguageSelector — compact globe + native select for the navbar.
 *
 * A native <select> is the most reliable control on mobile (uses the OS
 * picker) and needs no JS positioning. Persisted via LanguageProvider.
 */
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { LANGS, type Lang } from "@/lib/i18n/dictionaries";

export function LanguageSelector() {
  const { lang, setLang, t } = useLanguage();
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        cursor: "pointer",
      }}
      title={t("lang.label")}
    >
      <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1 }}>
        🌐
      </span>
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        aria-label={t("lang.label")}
        style={{
          background: "transparent",
          border: "1px solid var(--vs-border)",
          borderRadius: 999,
          color: "var(--vs-text)",
          fontFamily: "var(--vs-font)",
          fontSize: 13,
          padding: "8px 8px",
          cursor: "pointer",
        }}
      >
        {LANGS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.nativeLabel}
          </option>
        ))}
      </select>
    </label>
  );
}
