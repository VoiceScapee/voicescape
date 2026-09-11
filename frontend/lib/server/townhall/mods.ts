/**
 * Voicescape moderator access control (wallet level).
 *
 * `isMod(walletAddress)` is the single check for "is this wallet a
 * moderator". Mod wallets come from the MOD_WALLET_ADDRESSES env var
 * (comma-separated Hedera account IDs like 0.0.x and/or EVM 0x
 * addresses); the legacy TOWNHALL_MOD_WALLETS list is honored as an
 * alias so the moderation UI and the town-hall mod-action path agree.
 *
 * Addresses are canonicalized (0.0.x → long-zero 0x form; 0x… →
 * lowercase) so session addresses match regardless of the form the
 * operator wrote in the env var. Pure apart from env reads —
 * unit-testable.
 */

import { canonicalAddress } from "../../session-message";
import { getModWallets } from "./mod";

/** Canonical mod wallet addresses from MOD_WALLET_ADDRESSES. */
export function getModWalletAddresses(): string[] {
  return (process.env.MOD_WALLET_ADDRESSES ?? "")
    .split(",")
    .map((s) => canonicalAddress(s.trim()))
    .filter((s): s is string => s !== null);
}

/**
 * Is this wallet a moderator? True when its canonical address appears in
 * MOD_WALLET_ADDRESSES (or the legacy TOWNHALL_MOD_WALLETS list).
 */
export function isMod(walletAddress: string | null | undefined): boolean {
  if (!walletAddress) return false;
  const c = canonicalAddress(walletAddress);
  return c !== null && getModWallets().includes(c);
}
