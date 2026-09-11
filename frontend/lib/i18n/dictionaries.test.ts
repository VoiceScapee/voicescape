/**
 * i18n dictionary tests.
 *
 * The guarantees under test:
 * 1. Every language has exactly the same keys as English (no missing or
 *    extra keys) — so the UI can never render a blank string in any
 *    supported language.
 * 2. No translation value is empty.
 */
import { describe, expect, it } from "vitest";
import { dictionaries, LANGS, type Lang } from "./dictionaries";

describe("i18n dictionaries", () => {
  const enKeys = Object.keys(dictionaries.en).sort();

  it("declares English and Spanish", () => {
    const codes = LANGS.map((l) => l.code).sort();
    expect(codes).toEqual(["en", "es"]);
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
  }
});
