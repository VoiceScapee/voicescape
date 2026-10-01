/**
 * vault-costs — budget rules and exact cost math for Agent Vault setup.
 *
 * Brandon's pricing rule: the floor is the TRUE minimum — Hedera's gas
 * plus whatever the vault needs, zero platform markup. (The dapp's own
 * cost here is $0: mirror-node REST + KV.)
 *
 * The minimum vault funding is DYNAMIC: at setup time we fetch the live
 * HBAR/USD rate from the mirror node and compute
 *   floor = (AccountCreate $0.05 + one registerPage ~$0.05
 *            + revocation-reserve AccountUpdate $0.05) / hbarUsd
 * rounded UP to the tenth — currently ≈1.5 HBAR (≈$0.15). The human sees
 * the exact live-computed total BEFORE signing: vault funding + the
 * create fee, both priced live.
 *
 * Default 5 HBAR, 25 HBAR cap (gas money only — never a honeypot).
 * Mainnet only.
 */

export const VAULT_BUDGET_DEFAULT_HBAR = 5;
export const VAULT_BUDGET_MAX_HBAR = 25;
/**
 * USD the floor must cover: create 0.05 + one registerPage 0.05 +
 * revocation-reserve AccountUpdate 0.05. Zero markup.
 */
export const VAULT_FLOOR_USD = 0.15;
/** Absolute sanity floor — defense in depth, never the real gate. */
const ABSOLUTE_MIN_HBAR = 0.1;

/** Conservative fallback when the live rate is unreachable (HBAR). */
const CREATE_FEE_FALLBACK_HBAR = 0.5;
/** CryptoCreate is a ~$0.05 operation (USD-denominated fee schedule). */
const CREATE_FEE_USD = 0.05;
/** Revocation / key-rotation (AccountUpdate) is the same fee family. */
export const UPDATE_FEE_USD = 0.05;

export interface BudgetFloor {
  /** Minimum vault funding in HBAR, live-computed, rounded up to the tenth. */
  floorHbar: number;
  /** HBAR price in USD used for the computation. */
  hbarUsd: number;
  /** False when the mirror rate was unreachable (conservative fallback). */
  live: boolean;
}

interface ExchangeRate {
  hbarUsd: number;
}

/**
 * Live HBAR/USD from the mirror node. Never throws — falls back to a
 * conservative constant so the setup page can always show a number.
 */
export async function fetchHbarUsd(
  fetchFn: typeof fetch = fetch,
): Promise<{ rate: ExchangeRate; live: boolean }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await fetchFn(
        "https://mainnet.mirrornode.hedera.com/api/v1/network/exchangerate",
        { headers: { Accept: "application/json" }, signal: ctrl.signal },
      );
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as {
          current_rate?: { hbar_equivalent?: number; cent_equivalent?: number };
        } | null;
        const h = body?.current_rate?.hbar_equivalent;
        const c = body?.current_rate?.cent_equivalent;
        if (typeof h === "number" && typeof c === "number" && h > 0 && c > 0) {
          // c cents buy h HBAR → 1 HBAR = (c / h) cents.
          return { rate: { hbarUsd: c / h / 100 }, live: true };
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* fall through to the conservative fallback */
  }
  // Fallback prices the fee HIGH so we never under-quote the human.
  return { rate: { hbarUsd: CREATE_FEE_USD / CREATE_FEE_FALLBACK_HBAR }, live: false };
}

/**
 * The live minimum vault funding: $0.15 of gas-need converted at the
 * current rate, rounded UP to the tenth (never under-quote).
 */
export async function computeBudgetFloor(
  fetchFn: typeof fetch = fetch,
): Promise<BudgetFloor> {
  const { rate, live } = await fetchHbarUsd(fetchFn);
  const raw = VAULT_FLOOR_USD / rate.hbarUsd;
  const floorHbar = Math.max(ABSOLUTE_MIN_HBAR, Math.ceil(raw * 10) / 10);
  return { floorHbar, hbarUsd: rate.hbarUsd, live };
}

export function validateVaultBudget(
  raw: unknown,
  floorHbar: number,
): { ok: true; budgetHbar: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, budgetHbar: VAULT_BUDGET_DEFAULT_HBAR };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    return { ok: false, error: "budget must be a number of HBAR" };
  }
  // Round UP to the tenth — never under-fund the vault.
  const rounded = Math.ceil(n * 10) / 10;
  if (rounded < floorHbar) {
    return {
      ok: false,
      error:
        `budget must be at least ${floorHbar} HBAR right now (≈$${VAULT_FLOOR_USD.toFixed(2)} at the live rate) — ` +
        `that's the true minimum: the network fee to create the vault, one blockpage registration, ` +
        `and the reserve to revoke later. Zero markup.`,
    };
  }
  if (rounded > VAULT_BUDGET_MAX_HBAR) {
    return {
      ok: false,
      error: `budget is capped at ${VAULT_BUDGET_MAX_HBAR} HBAR — the vault holds gas money only, never a balance worth attacking`,
    };
  }
  return { ok: true, budgetHbar: rounded };
}

export interface VaultCostEstimate {
  /** HBAR the human chose to fund the vault with. */
  budgetHbar: number;
  /** Estimated create-fee in HBAR (live rate when reachable). */
  createFeeHbar: number;
  /** Total HBAR leaving the human's wallet on the setup signature. */
  totalHbar: number;
  /** Same figures in USD for plain-words display. */
  budgetUsd: number;
  createFeeUsd: number;
  totalUsd: number;
  /** "live" when priced off the mirror-node exchange rate, else "fallback". */
  pricedFrom: "live" | "fallback";
  /** HBAR price used, for the receipt line. */
  hbarUsd: number;
}

/** Exact total for the setup signature: fee estimate + vault funding. */
export async function estimateVaultSetupCost(
  budgetHbar: number,
  fetchFn: typeof fetch = fetch,
): Promise<VaultCostEstimate> {
  const { rate, live } = await fetchHbarUsd(fetchFn);
  const createFeeHbar = live
    ? Math.ceil((CREATE_FEE_USD / rate.hbarUsd) * 100) / 100
    : CREATE_FEE_FALLBACK_HBAR;
  const totalHbar = Math.ceil((budgetHbar + createFeeHbar) * 100) / 100;
  return {
    budgetHbar,
    createFeeHbar,
    totalHbar,
    budgetUsd: budgetHbar * rate.hbarUsd,
    createFeeUsd: CREATE_FEE_USD,
    totalUsd: totalHbar * rate.hbarUsd,
    pricedFrom: live ? "live" : "fallback",
    hbarUsd: rate.hbarUsd,
  };
}

/** "≈5.49 HBAR (≈$0.57)" — the one-line receipt shown before signing. */
export function formatCostLine(c: VaultCostEstimate): string {
  const usd = (n: number) =>
    n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
  return (
    `≈${c.totalHbar} HBAR (≈${usd(c.totalUsd)}) leaves your wallet: ` +
    `${c.budgetHbar} HBAR vault funding + ≈${c.createFeeHbar} HBAR network fee. ` +
    `Nothing else can move until you sign again.`
  );
}
