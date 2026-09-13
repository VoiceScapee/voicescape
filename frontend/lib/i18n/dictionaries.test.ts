/**
 * i18n dictionary tests.
 *
 * The guarantees under test:
 * 1. Every language has exactly the same keys as English (no missing or
 *    extra keys) — so the UI can never render a blank string in any
 *    supported language.
 * 2. No translation value is empty.
 * 3. No fabricated social-proof metrics or auto-build promises anywhere
 *    (honest-copy sweep — see claims audit 2026-09-13).
 */
import { describe, expect, it } from "vitest";
import { dictionaries, LANGS, type Lang } from "./dictionaries";

/** Phrases that would fabricate traction — must never appear in any language. */
const FABRICATED_METRICS = [
  "24k",
  "400k",
  "millions",
  "thousands of",
  "trusted by",
  "join thousands",
  "join millions",
];

/** Auto-build promises that contradict the real draft → review → apply flow. */
const AUTO_BUILD_PHRASES = [
  "assemble itself",
  "construirse sola",
  "se arma sola",
  "自动组装",
  "खुद बन जाता है",
  // landing.f2t must say the AI *drafts*, never that it builds on its own.
  "AI builds it",
  "la IA lo construye",
  "AI 来建造",
  "AI बनाएगा",
  "الذكاء الاصطناعي يبني",
  "a IA constrói",
  "l'IA le construit",
  // splash.sub hero forms (now fixed to drafting language — keep them fixed).
  "la IA la construye",
  "AI 为您建造",
  "AI उसे बनाता है",
  "a IA construí-la",
  "l'IA la construire",
  // landing.step2t forms (now "Make it yours" everywhere — keep them so).
  "看 AI 建造",
  "AI को बनाते देखें",
  "Veja a IA construir",
  "Regardez l'IA construire",
  // landing.heroBody forms (now draft → you adjust — keep them so).
  "la IA construye tu página",
  "AI 会逐块为您建造页面",
  "AI आपका पेज ब्लॉक दर ब्लॉक बना देगा",
  "a IA constrói sua página",
  "l'IA construit votre page",
  "खुद-ब-खुद",
  "تُبنى بنفسها",
  "se montar sozinha",
  "s'assembler toute seule",
];

describe("i18n dictionaries", () => {
  const enKeys = Object.keys(dictionaries.en).sort();

  it("declares all seven supported languages", () => {
    const codes = LANGS.map((l) => l.code).sort();
    expect(codes).toEqual(["ar", "en", "es", "fr", "hi", "pt", "zh"]);
  });

  for (const { code } of LANGS) {
    it(`${code} has full key parity with English`, () => {
      const keys = Object.keys(dictionaries[code as Lang]).sort();
      expect(keys).toEqual(enKeys);
    });

    it(`${code} has no empty translations`, () => {
      for (const [k, v] of Object.entries(dictionaries[code as Lang])) {
        expect(v.trim().length, `empty translation: ${k}`).toBeGreaterThan(0);
      }
    });

    it(`${code} contains no fabricated metrics`, () => {
      for (const [k, v] of Object.entries(dictionaries[code as Lang])) {
        const lower = v.toLowerCase();
        for (const phrase of FABRICATED_METRICS) {
          expect(lower, `fabricated metric "${phrase}" in ${k}`).not.toContain(phrase);
        }
      }
    });

    it(`${code} makes no auto-build promises`, () => {
      for (const [k, v] of Object.entries(dictionaries[code as Lang])) {
        for (const phrase of AUTO_BUILD_PHRASES) {
          expect(v, `auto-build promise "${phrase}" in ${k}`).not.toContain(phrase);
        }
      }
    });

    it(`${code} hedera specs use documented finality (3–5s, not ~2s)`, () => {
      const specs = dictionaries[code as Lang]["splash.hederaSpecs"];
      expect(specs).not.toMatch(/~2s|约2秒|2 सेकंड|ثانيتين\b/);
    });
  }

  it("en AI-builder copy describes draft → review → apply, not auto-build", () => {
    const f2b = dictionaries.en["landing.f2b"];
    expect(f2b.toLowerCase()).toMatch(/draft/);
    expect(f2b.toLowerCase()).toMatch(/review/);
    expect(f2b.toLowerCase()).toMatch(/apply or discard/);
  });
});
