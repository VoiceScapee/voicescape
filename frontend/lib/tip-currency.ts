/**
 * Shared tip-currency helpers: the visitor picks USD or HBAR once and both
 * tip surfaces (blockpage tip panel, town-hall post tips) honor it.
 */

/** localStorage key for the visitor's chosen tip currency. */
export const TIP_CURRENCY_KEY = "vs-tip-currency";

export type TipCurrency = "usd" | "hbar";

/** Broadcast when the blockpage tip panel opens/closes so the floating
 *  Buddy button can get out of the way (detail: true = open). */
export const TIP_PANEL_EVENT = "vs-tip-panel";

export function readTipCurrency(): TipCurrency {
  try {
    return window.localStorage.getItem(TIP_CURRENCY_KEY) === "hbar" ? "hbar" : "usd";
  } catch {
    return "usd";
  }
}

/** Normalize a typed amount: strip junk, and turn ".37" into "0.37". */
export function normalizeTipInput(v: string): string {
  const cleaned = v.replace(/[^0-9.]/g, "");
  return cleaned.startsWith(".") ? `0${cleaned}` : cleaned;
}
