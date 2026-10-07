/**
 * Shared wallet guards — tiny module with zero heavy imports, so the HCS
 * submit path (lib/hcs-wallet.ts) can use them without statically pulling
 * in @hiero-ledger/sdk (which lib/tx.ts imports at top level and
 * hcs-wallet.ts deliberately loads dynamically).
 */

/**
 * Wallet-rejection signal, kept in sync with friendlyWalletError in
 * lib/wallet.tsx. A rejected signature is never broadcast, so it can never
 * land on-chain — safe to clear from the pending-intent ledger.
 */
export const WALLET_REJECTION_PATTERN =
  /\b(4001|user rejected|request rejected|transaction (was )?rejected|declined|cancelled|canceled)\b/i;

export function isWalletRejection(e: unknown): boolean {
  return e instanceof Error && WALLET_REJECTION_PATTERN.test(e.message);
}

/**
 * Check whether a WalletConnect session is still alive. Stale sessions
 * (HashPack #291) silently swallow signing requests — no prompt, no error.
 *
 * Fail-open: if the session state can't be determined, returns true rather
 * than blocking a working flow.
 */
export function isWalletSessionAlive(dAppConnector: unknown): boolean {
  try {
    const client = (
      dAppConnector as unknown as {
        walletConnectClient?: { session?: { getAll?: () => unknown[] } };
      }
    ).walletConnectClient;
    const sessions = client?.session?.getAll?.();
    // getAll() returning undefined = can't determine; fail open.
    if (sessions === undefined) return true;
    return sessions.length > 0;
  } catch {
    return true;
  }
}
