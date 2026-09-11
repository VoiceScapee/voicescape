"use client";

/**
 * <T k="..."> — translate a string inside server components.
 *
 * Server components can't call hooks, so they render this tiny client
 * component wherever a translated string is needed. Keeps pages
 * server-rendered while the copy stays localizable.
 */
import { useLanguage } from "@/lib/i18n/LanguageContext";
import type { I18nKey } from "@/lib/i18n/dictionaries";

export function T({ k }: { k: I18nKey }) {
  const { t } = useLanguage();
  return <>{t(k)}</>;
}
