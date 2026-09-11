/**
 * Local-currency display for HBAR amounts — free APIs only ($0 rule).
 *
 * - HBAR→USD comes from the existing CoinGecko feed (lib/x402.ts).
 * - USD→local comes from open.er-api.com (free, no key, CORS-enabled),
 *   cached 1h in memory + 6h in localStorage, with a USD-only fallback
 *   when offline. Display-only: never used for settlement.
 * - The user's currency is guessed from navigator.language's region
 *   subtag (e.g. es-MX → MXN). Unknown regions fall back to USD.
 */

let fxCache: { rates: Record<string, number>; at: number } | null = null;
const LS_KEY = "vs_fx_rates";
const MEM_TTL = 60 * 60_000; // 1 hour
const LS_TTL = 6 * 60 * 60_000; // 6 hours

/** USD-based FX rates. Never rejects — falls back to { USD: 1 }. */
export async function getFxRates(): Promise<Record<string, number>> {
  const now = Date.now();
  if (fxCache && now - fxCache.at < MEM_TTL) return fxCache.rates;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { rates: Record<string, number>; at: number };
      if (parsed?.rates && now - parsed.at < LS_TTL) {
        fxCache = parsed;
        return parsed.rates;
      }
    }
  } catch {
    /* storage unavailable — try network */
  }
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const json = (await res.json()) as { result?: string; rates?: Record<string, number> };
    if (json?.result === "success" && json.rates && json.rates.USD === 1) {
      fxCache = { rates: json.rates, at: now };
      try {
        window.localStorage.setItem(LS_KEY, JSON.stringify(fxCache));
      } catch {
        /* best-effort cache */
      }
      return json.rates;
    }
  } catch {
    /* offline — fall through */
  }
  return { USD: 1 };
}

const REGION_CURRENCY: Record<string, string> = {
  US: "USD",
  GB: "GBP",
  ES: "EUR", FR: "EUR", DE: "EUR", IT: "EUR", PT: "EUR", NL: "EUR", IE: "EUR",
  AT: "EUR", BE: "EUR", FI: "EUR", GR: "EUR", SK: "EUR", SI: "EUR", EE: "EUR",
  LV: "EUR", LT: "EUR", CY: "EUR", MT: "EUR", LU: "EUR", HR: "EUR",
  MX: "MXN", AR: "ARS", CO: "COP", CL: "CLP", PE: "PEN", VE: "VES", UY: "UYU",
  BO: "BOB", PY: "PYG", EC: "USD", BR: "BRL",
  CA: "CAD", AU: "AUD", NZ: "NZD", JP: "JPY", CN: "CNY", IN: "INR", KR: "KRW",
  CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CZ: "CZK", HU: "HUF",
  RO: "RON", BG: "BGN", ZA: "ZAR", NG: "NGN", KE: "KES", GH: "GHS", EG: "EGP",
  PH: "PHP", ID: "IDR", MY: "MYR", TH: "THB", VN: "VND", SG: "SGD", HK: "HKD",
  TW: "TWD", TR: "TRY", AE: "AED", SA: "SAR", QA: "QAR", IL: "ILS", RU: "RUB",
  UA: "UAH", PK: "PKR", BD: "BDT",
};

/** Guess the user's ISO currency code from their locale. Falls back to USD. */
export function localeCurrency(locale?: string): string {
  try {
    const loc =
      locale ||
      (typeof navigator !== "undefined" ? navigator.language : "en-US");
    const region = loc.split(/[-_]/)[1]?.toUpperCase();
    if (region && REGION_CURRENCY[region]) return REGION_CURRENCY[region];
  } catch {
    /* fall through */
  }
  return "USD";
}

/**
 * Format a USD amount in the user's local currency.
 * Pure function — pass the rates from getFxRates().
 */
export function formatLocalCurrency(
  usdAmount: number,
  rates: Record<string, number>,
  locale?: string,
): string {
  const loc = locale || (typeof navigator !== "undefined" ? navigator.language : "en-US");
  const currency = localeCurrency(loc);
  const rate = rates[currency] ?? 1;
  try {
    return new Intl.NumberFormat(loc, { style: "currency", currency }).format(
      usdAmount * rate,
    );
  } catch {
    return `$${(usdAmount * rate).toFixed(2)}`;
  }
}
