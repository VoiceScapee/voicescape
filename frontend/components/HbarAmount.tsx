"use client";

/**
 * <HbarAmount> — displays an HBAR amount with the approximate local-currency
 * equivalent in parentheses, e.g. "0.5 HBAR (≈ €0.09)".
 *
 * The fiat figure is best-effort and display-only: if either price feed
 * fails, it degrades gracefully to just "X HBAR".
 */
import { useEffect, useState } from "react";
import { getHbarUsdPrice } from "@/lib/x402";
import { formatLocalCurrency, getFxRates } from "@/lib/fx";

export function HbarAmount({
  hbar,
  style,
}: {
  hbar: number | string;
  style?: React.CSSProperties;
}) {
  const [fiat, setFiat] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [hbarUsd, rates] = await Promise.all([getHbarUsdPrice(), getFxRates()]);
        const n = typeof hbar === "string" ? Number(hbar) : hbar;
        if (!Number.isFinite(n)) return;
        const str = formatLocalCurrency(n * hbarUsd, rates);
        if (alive) setFiat(str);
      } catch {
        /* fiat display is best-effort */
      }
    })();
    return () => {
      alive = false;
    };
  }, [hbar]);

  return (
    <span style={style}>
      {hbar} HBAR
      {fiat ? <span style={{ opacity: 0.65 }}> (≈ {fiat})</span> : null}
    </span>
  );
}
