"use client";

/**
 * LanguageProvider — app-wide i18n state.
 *
 * - Language persists in localStorage ("vs_lang").
 * - First visit defaults to the browser language (matched against the
 *   supported codes, e.g. "pt-BR" → "pt", "ar-EG" → "ar"), otherwise English.
 * - t(key) falls back to English, then to the key itself — never blank.
 * - Keeps <html lang> in sync for screen readers and SEO, and sets
 *   dir="rtl" for right-to-left languages (Arabic).
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  dictionaries,
  LANGS,
  RTL_LANGS,
  type I18nKey,
  type Lang,
} from "./dictionaries";

const STORAGE_KEY = "vs_lang";

function detectInitialLang(): Lang {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && LANGS.some((l) => l.code === saved)) return saved as Lang;
    const nav = (window.navigator.language || "en").toLowerCase();
    const match = LANGS.find((l) => l.code !== "en" && nav.startsWith(l.code));
    if (match) return match.code;
  } catch {
    /* storage unavailable — fall through to English */
  }
  return "en";
}

interface LanguageContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Translate a key; falls back to English, then the key itself. */
  t: (k: I18nKey) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // Start English for SSR/hydration consistency; upgrade to the stored or
  // browser language on mount (avoids hydration mismatch).
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    setLangState(detectInitialLang());
  }, []);

  useEffect(() => {
    try {
      document.documentElement.lang = lang;
      document.documentElement.dir = RTL_LANGS.includes(lang) ? "rtl" : "ltr";
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* storage unavailable — language still applies for this visit */
    }
  }, [lang]);

  const setLang = useCallback((l: Lang) => setLangState(l), []);
  const t = useCallback(
    (k: I18nKey): string => dictionaries[lang][k] ?? dictionaries.en[k] ?? k,
    [lang],
  );

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used inside LanguageProvider");
  return ctx;
}
