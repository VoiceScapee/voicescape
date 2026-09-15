/**
 * Testnet-only configuration for the Phase 5 paid agent endpoint prototype.
 *
 * HARD GUARD: this module is incapable of operating against Hedera mainnet
 * by construction —
 *   1. The mirror base URL is a hardcoded testnet constant (no env override).
 *   2. The Tips contract id must be `0.0.x` form and is rejected when it is a
 *      known mainnet id.
 *   3. `assertTestnetMirror()` refuses any URL containing "mainnet".
 *
 * Fail-closed: every accessor throws when misconfigured instead of
 * defaulting to something usable.
 */

export const TESTNET_MIRROR_BASE =
  "https://testnet.mirrornode.hedera.com/api/v1";
export const TESTNET_CHAIN_ID = 296;
export const MAINNET_CHAIN_ID = 295;

/** keccak256("tipPage(string)") first 4 bytes. */
export const TIP_PAGE_SELECTOR = "0x8b0de5cb";

/** Price for every product on this rail (Brandon, 2026-09-15). */
export const PRICE_HBAR = 5;
/** Fee headroom required on top of the price at order issuance. */
export const FEE_BUFFER_HBAR = 0.5;
/** Order expiry. */
export const ORDER_TTL_MS = 15 * 60 * 1000;

export type PaidProduct = "chat-50" | "blockpage-build";
export const PAID_PRODUCTS: PaidProduct[] = ["chat-50", "blockpage-build"];

/** Mainnet contract ids that must never be accepted by this prototype. */
const MAINNET_IDS = new Set([
  "0.0.10854060",
  "0x571d6d0c5d5ee7fc1e47283ad864305b7f7a88e0",
]);

export interface PaidConfig {
  /** Tips contract account id, `0.0.x` form, testnet only. */
  tipsAccountId: string;
  /** Always the hardcoded testnet mirror base. */
  mirrorBase: string;
  /**
   * The ONE username buyers pay via tipPage for a paid order — the AI
   * agent/blockpage they are interacting with (mainnet: `forge`,
   * Blockpage Buddy). Brandon's standing rule (2026-09-15, refined same
   * day): keep it simple — the buyer pays the Buddy; the Buddy's wallet
   * then forwards profits to BRANDON'S wallet (0.0.10424063) and to no
   * one else. The atomic 98/2 split still applies per sale: 98% to the
   * Buddy's wallet, 2% straight to Brandon's treasury. The endpoint
   * itself is receive-only — no server keys, no payout/withdraw paths.
   */
  recipientUsername: string;
}

export function isAccountIdForm(id: string): boolean {
  return /^0\.0\.\d+$/.test(id);
}

export function assertTestnetMirror(url: string): void {
  if (!url || typeof url !== "string" || !url.startsWith("https://")) {
    throw new Error("paid_endpoint_misconfigured: invalid mirror base");
  }
  if (url.toLowerCase().includes("mainnet")) {
    throw new Error(
      "paid_endpoint_mainnet_forbidden: refusing a mainnet mirror node",
    );
  }
}

/**
 * Read and validate the prototype config. Throws (fail-closed) when:
 * - A2A_TESTNET_TIPS_ID is unset/empty,
 * - it is not `0.0.x` form,
 * - it is a known mainnet Tips contract id,
 * - A2A_RECIPIENT_USERNAME is unset/empty (Brandon's rule: revenue goes to
 *   HIS wallet — the paid endpoint must know the one username it accepts).
 */
export function getPaidConfig(
  env: Record<string, string | undefined> = process.env,
): PaidConfig {
  const raw = (env.A2A_TESTNET_TIPS_ID ?? "").trim();
  if (!raw) {
    throw new Error(
      "paid_endpoint_misconfigured: A2A_TESTNET_TIPS_ID is not set — " +
        "deploy the Tips contract to Hedera testnet and set its 0.0.x id",
    );
  }
  if (!isAccountIdForm(raw)) {
    throw new Error(
      "paid_endpoint_misconfigured: A2A_TESTNET_TIPS_ID must be 0.0.x form " +
        "(EVM addresses are rejected to keep the mainnet guard unambiguous)",
    );
  }
  if (MAINNET_IDS.has(raw)) {
    throw new Error(
      "paid_endpoint_mainnet_forbidden: refusing to operate against the " +
        "mainnet Tips contract — this is a testnet-only prototype",
    );
  }
  assertTestnetMirror(TESTNET_MIRROR_BASE);
  const recipientUsername = (env.A2A_RECIPIENT_USERNAME ?? "").trim();
  if (!recipientUsername) {
    throw new Error(
      "paid_endpoint_misconfigured: A2A_RECIPIENT_USERNAME is not set — " +
        "the one agent username buyers may pay (Blockpage Buddy on mainnet)",
    );
  }
  return {
    tipsAccountId: raw,
    mirrorBase: TESTNET_MIRROR_BASE,
    recipientUsername,
  };
}

/** Normalize a contract-result `to` field (long-zero EVM or 0.0.x) to 0.0.x. */
export function normalizeToAccountId(to: string | null | undefined): string | null {
  if (!to) return null;
  const m = /^0x0{24}([0-9a-fA-F]{1,16})$/.exec(to);
  if (m) {
    // Long-zero form 0x0000...<hex shard.realm.num>. Testnet/mainnet both
    // use shard 0 realm 0, so this is the account num.
    return `0.0.${parseInt(m[1], 16)}`;
  }
  if (isAccountIdForm(to)) return to;
  return to.toLowerCase();
}

export function hbarToTinybar(hbar: number): bigint {
  return BigInt(Math.round(hbar * 1e8));
}
