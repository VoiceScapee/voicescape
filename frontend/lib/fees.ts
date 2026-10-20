/**
 * Measured mainnet fee facts for the Tips contract (0.0.10854060).
 *
 * Observed via the Hedera mirror node, Oct 2026: tip contract calls
 * charged 0.053–0.09 HBAR (≈ $0.010–0.017 at $0.19/HBAR). Displayed
 * conservatively as ≈ 0.08 HBAR / ≈ $0.01.
 *
 * This is the CONTRACT CALL fee. Never print the $0.0001 simple-transfer
 * fee for a tip — that number is true for plain HBAR transfers and false
 * for contract calls, and printing it would be dishonest.
 */
export const TIP_NETWORK_FEE_HBAR = "0.08";
export const TIP_NETWORK_FEE_USD_APPROX = "$0.01";
/** Human label for Hedera finality on tips. */
export const TIP_FINALITY_LABEL = "~3s";
