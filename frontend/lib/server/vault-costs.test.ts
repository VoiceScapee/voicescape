/**
 * Tests for vault-costs: dynamic floor, validation, live-priced estimates.
 * Mirror-node fetch is injected — no network in tests.
 */
import { describe, it, expect } from "vitest";
import {
  VAULT_BUDGET_DEFAULT_HBAR,
  VAULT_BUDGET_MAX_HBAR,
  VAULT_FLOOR_USD,
  computeBudgetFloor,
  validateVaultBudget,
  estimateVaultSetupCost,
  formatCostLine,
} from "./vault-costs";

/** Mirror exchangerate fixture: 30,000 HBAR ↔ 308,806 cents → $0.10294. */
function rateFetch(hbar = 30_000, cents = 308_806) {
  const fn = async () => ({
    ok: true,
    json: async () => ({
      current_rate: { hbar_equivalent: hbar, cent_equivalent: cents },
    }),
  });
  return fn as unknown as typeof fetch;
}

function deadFetch() {
  const fn = async (): Promise<never> => {
    throw new Error("network down");
  };
  return fn as unknown as typeof fetch;
}

describe("computeBudgetFloor", () => {
  it("computes the true-minimum floor from the live rate (≈1.5 HBAR at $0.10294)", async () => {
    const floor = await computeBudgetFloor(rateFetch());
    expect(floor.live).toBe(true);
    // $0.15 / $0.10294 = 1.457… → ceil to tenth = 1.5
    expect(floor.floorHbar).toBe(1.5);
    expect(floor.hbarUsd).toBeCloseTo(0.10294, 4);
  });

  it("falls back conservatively when the rate is unreachable", async () => {
    const floor = await computeBudgetFloor(deadFetch());
    expect(floor.live).toBe(false);
    // Fallback prices HBAR at $0.10 → $0.15 = 1.5 HBAR.
    expect(floor.floorHbar).toBe(1.5);
  });

  it("tracks the rate — a $1 HBAR means a $0.15 → 0.2 HBAR floor", async () => {
    const floor = await computeBudgetFloor(rateFetch(100, 10_000)); // $1.00
    expect(floor.floorHbar).toBe(0.2); // 0.15 → ceil tenth
  });
});

describe("validateVaultBudget", () => {
  const FLOOR = 1.5;

  it("defaults to 5 HBAR when omitted", () => {
    expect(validateVaultBudget(undefined, FLOOR)).toEqual({ ok: true, budgetHbar: 5 });
    expect(validateVaultBudget("", FLOOR)).toEqual({ ok: true, budgetHbar: 5 });
    expect(VAULT_BUDGET_DEFAULT_HBAR).toBe(5);
  });

  it("rejects below the live floor with the true-minimum explanation", () => {
    const res = validateVaultBudget(1.0, FLOOR);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("1.5 HBAR");
      expect(res.error).toContain("$0.15");
      expect(res.error).toContain("Zero markup");
    }
  });

  it("accepts the floor exactly and rounds up to the tenth", () => {
    expect(validateVaultBudget(1.5, FLOOR)).toEqual({ ok: true, budgetHbar: 1.5 });
    // 1.44 rounds UP to 1.5 — never under-fund.
    expect(validateVaultBudget(1.44, FLOOR)).toEqual({ ok: true, budgetHbar: 1.5 });
  });

  it("rejects above the 25 HBAR cap", () => {
    const res = validateVaultBudget(26, FLOOR);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("25 HBAR");
    expect(VAULT_BUDGET_MAX_HBAR).toBe(25);
  });

  it("rejects non-numbers", () => {
    expect(validateVaultBudget("lots", FLOOR).ok).toBe(false);
  });
});

describe("estimateVaultSetupCost", () => {
  it("prices funding + create fee live, total never under-quotes", async () => {
    const c = await estimateVaultSetupCost(5, rateFetch());
    expect(c.pricedFrom).toBe("live");
    expect(c.budgetHbar).toBe(5);
    // $0.05 / $0.10294 = 0.4857… → ceil to cent = 0.49
    expect(c.createFeeHbar).toBe(0.49);
    expect(c.totalHbar).toBe(5.49);
    expect(c.totalUsd).toBeCloseTo(5.49 * 0.10294, 2);
  });

  it("falls back to the conservative constant when the rate is down", async () => {
    const c = await estimateVaultSetupCost(5, deadFetch());
    expect(c.pricedFrom).toBe("fallback");
    expect(c.createFeeHbar).toBe(0.5);
    expect(c.totalHbar).toBe(5.5);
  });
});

describe("formatCostLine", () => {
  it("renders the one-line receipt shown before signing", async () => {
    const c = await estimateVaultSetupCost(5, rateFetch());
    const line = formatCostLine(c);
    expect(line).toContain("5.49 HBAR");
    expect(line).toContain("leaves your wallet");
    expect(line).toContain("Nothing else can move until you sign again");
  });
});

describe("floor economics", () => {
  it("the floor covers create + registerPage + revocation reserve ($0.15)", () => {
    expect(VAULT_FLOOR_USD).toBe(0.15);
  });
});
