/**
 * Token/amount helpers for on-chain payments.
 *
 * Tips are HBAR-only and go through the VoicescapeTips contract, which
 * enforces the 98/2 split atomically. (A USDC tip rail used to exist as a
 * direct wallet→owner transfer with no protocol split — it was cut because
 * a fee users can dodge by switching rails isn't a fee. USDC remains a
 * payment rail for x402 service payments — see lib/x402.ts Rail 2.)
 */

/** Convert a USD amount to HBAR tinybars at the given HBAR/USD price. */
export function usdToTinybars(usd: number, hbarUsdPrice: number): bigint {
  if (!(hbarUsdPrice > 0)) throw new Error("Invalid HBAR price.");
  return BigInt(Math.round((usd / hbarUsdPrice) * 100_000_000));
}

/** Convert a USD amount to wei (18 decimals) for the HBAR contract tip flow. */
export function usdToWei(usd: number, hbarUsdPrice: number): bigint {
  if (!(hbarUsdPrice > 0)) throw new Error("Invalid HBAR price.");
  return BigInt(Math.floor((usd / hbarUsdPrice) * 1e18));
}
