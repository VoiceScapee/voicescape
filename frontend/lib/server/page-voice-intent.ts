/**
 * Page voice mic — pure intent logic (no I/O, no Next, no chain).
 *
 * The deterministic router behind POST /api/page-voice: matches a spoken
 * transcript against the page's REAL blocks (never invents capabilities),
 * with en/es keyword coverage and English fallback per the dapp's i18n
 * convention. Kept dependency-free so it unit-tests in milliseconds.
 */

import { LANGS, type Lang } from "@/lib/i18n/dictionaries";

const LANG_CODES = new Set<string>(LANGS.map((l) => l.code));

/** Validate the client's lang; fall back to navigatorLang, then English. */
export function resolveLang(lang: unknown, navigatorLang: unknown): Lang {
  if (typeof lang === "string" && LANG_CODES.has(lang)) return lang as Lang;
  if (typeof navigatorLang === "string") {
    const short = navigatorLang.slice(0, 2).toLowerCase();
    if (LANG_CODES.has(short)) return short as Lang;
  }
  return "en";
}

export type IntentId = "music" | "livestream" | "bio" | "links" | "gallery" | "tip" | "booking";

export interface IntentDef {
  id: IntentId;
  /** Block types that must exist for this intent to be offered. */
  needs: string[];
  /** en|es keyword patterns (the dapp's English-fallback i18n convention). */
  pattern: RegExp;
  scrollTo?: string;
}

export const INTENTS: IntentDef[] = [
  { id: "tip", needs: ["tipJar"], pattern: /\btips?\b|donat|support|propina|donar|donaci[oó]n|apoyar/ },
  {
    id: "livestream",
    needs: ["livestream"],
    pattern: /\blive\b|stream|en vivo|directo|transmisi[oó]n/,
    scrollTo: "livestream",
  },
  {
    id: "music",
    needs: ["music"],
    pattern: /music|m[uú]sica|canci[oó]n|\bsongs?\b|\bplay\b|reproduc|toca/,
    scrollTo: "music",
  },
  { id: "booking", needs: ["booking"], pattern: /\bbook\b|booking|hire|reservar?|contratar/ },
  {
    id: "gallery",
    needs: ["gallery"],
    pattern: /photo|picture|gallery|image|foto|galer[ií]a|im[aá]genes?/,
    scrollTo: "gallery",
  },
  {
    id: "links",
    needs: ["links", "socials"],
    pattern: /\blinks?\b|social|s[ií]gueme|follow|enlaces?|redes/,
    scrollTo: "links",
  },
  {
    id: "bio",
    needs: ["hero", "bio"],
    pattern: /who is|who's|story|about|\bbio\b|qui[eé]n|historia|cu[eé]ntame|acerca/,
  },
];

/** First intent whose keywords match AND whose blocks exist on the page. */
export function matchIntent(transcript: string, blockTypes: Set<string>): IntentDef | null {
  const lower = transcript.toLowerCase();
  for (const intent of INTENTS) {
    if (!intent.pattern.test(lower)) continue;
    if (!intent.needs.some((t) => blockTypes.has(t))) continue;
    return intent;
  }
  return null;
}

/** en/es template pick — English fallback, the dapp i18n convention. */
export function t(lang: Lang, en: string, es: string): string {
  return lang === "es" ? es : en;
}

export function truncateSentence(text: string, max = 200): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  // Prefer the last complete sentence; only hard-cut when the only
  // boundary is a degenerate fragment ("Hi.").
  return (lastStop > 15 ? cut.slice(0, lastStop + 1) : cut + "…").trim();
}

const CAPABILITY_LABELS: Record<string, { en: string; es: string }> = {
  music: { en: "play their music", es: "escuchar su música" },
  livestream: { en: "check the livestream", es: "ver el stream" },
  bio: { en: "hear their story", es: "conocer su historia" },
  gallery: { en: "see photos", es: "ver fotos" },
  links: { en: "see their links", es: "ver sus enlaces" },
  tipJar: { en: "open the tip box", es: "abrir la caja de propinas" },
  booking: { en: "booking options", es: "opciones de reserva" },
};

/**
 * Honest last resort: offer what the page ACTUALLY has. Never invents.
 * hero/socials fold into the bio/links capabilities they back.
 */
export function capabilityReply(
  blockTypes: Set<string>,
  lang: Lang,
): { speak: string; steps: string[] } {
  const types = new Set(blockTypes);
  if (types.has("hero") || types.has("bio")) types.add("bio");
  if (types.has("socials")) types.add("links");
  const options = Object.keys(CAPABILITY_LABELS).filter((k) => types.has(k));
  const useEs = lang === "es";
  const labels = options.map((k) => CAPABILITY_LABELS[k][useEs ? "es" : "en"]);
  const list =
    labels.length > 1
      ? `${labels.slice(0, -1).join(", ")} ${useEs ? "o" : "or"} ${labels[labels.length - 1]}`
      : (labels[0] ?? "");
  return {
    speak: t(
      lang,
      `Here's what I can do on this page: ${list}.`,
      `Esto es lo que puedo hacer en esta página: ${list}.`,
    ),
    steps: [],
  };
}
