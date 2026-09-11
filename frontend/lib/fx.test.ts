/**
 * FX / locale-currency tests.
 *
 * The guarantees under test:
 * 1. localeCurrency maps common locales to the right ISO currency.
 * 2. Unknown locales fall back to USD (never throw, never blank).
 * 3. formatLocalCurrency converts with the given rates and formats via
 *    Intl — deterministic for a fixed locale.
 */
import { describe, expect, it } from "vitest";
import { formatLocalCurrency, localeCurrency } from "./fx";

describe("localeCurrency", () => {
  it("maps Spanish Latin America locales", () => {
    expect(localeCurrency("es-MX")).toBe("MXN");
    expect(localeCurrency("es-AR")).toBe("ARS");
    expect(localeCurrency("es-CO")).toBe("COP");
    expect(localeCurrency("es-CL")).toBe("CLP");
    expect(localeCurrency("es-PE")).toBe("PEN");
  });

  it("maps European locales to EUR", () => {
    expect(localeCurrency("es-ES")).toBe("EUR");
    expect(localeCurrency("fr-FR")).toBe("EUR");
    expect(localeCurrency("de-DE")).toBe("EUR");
  });

  it("maps other major locales", () => {
    expect(localeCurrency("en-US")).toBe("USD");
    expect(localeCurrency("en-GB")).toBe("GBP");
    expect(localeCurrency("pt-BR")).toBe("BRL");
    expect(localeCurrency("ja-JP")).toBe("JPY");
    expect(localeCurrency("en-NG")).toBe("NGN");
  });

  it("falls back to USD for unknown locales", () => {
    expect(localeCurrency("xx-YY")).toBe("USD");
    expect(localeCurrency("en")).toBe("USD");
    expect(localeCurrency("")).toBe("USD");
  });
});

describe("formatLocalCurrency", () => {
  const rates = { USD: 1, EUR: 0.9, MXN: 17 };

  it("converts and formats in the locale currency", () => {
    // 10 USD * 0.9 = 9 EUR, formatted de-DE
    const s = formatLocalCurrency(10, rates, "de-DE");
    expect(s).toContain("9");
    expect(s).toContain("€");
  });

  it("falls back to USD rate 1 for unknown currencies", () => {
    const s = formatLocalCurrency(10, { USD: 1 }, "xx-YY");
    expect(s).toContain("10");
  });
});
