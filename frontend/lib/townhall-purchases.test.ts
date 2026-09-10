/**
 * Purchase-receipt tests: completed direct sales are recorded locally
 * (no escrow to track — the atomic transaction IS the settlement).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPurchases, recordPurchase, removePurchase } from "./townhall";

function installStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("purchase receipts", () => {
  it("records and returns purchases newest-first", async () => {
    installStorage();
    recordPurchase({ listingId: "a", note: "First", tx: "0x1", amountHbar: "≈ 1.0 HBAR", seller: "0.0.7" });
    recordPurchase({ listingId: "b", note: "Second", tx: "0x2", amountHbar: "≈ 2.0 HBAR", seller: "0.0.8" });
    const list = getPurchases();
    expect(list).toHaveLength(2);
    expect(list[0].listingId).toBe("b");
    expect(list[1].listingId).toBe("a");
    expect(list[0].tx).toBe("0x2");
    expect(typeof list[0].boughtAt).toBe("number");
  });

  it("dedupes re-recorded tx+listing pairs instead of stacking them", () => {
    installStorage();
    recordPurchase({ listingId: "a", note: "One", tx: "0x1", amountHbar: "1", seller: "s" });
    recordPurchase({ listingId: "a", note: "One", tx: "0x1", amountHbar: "1", seller: "s" });
    expect(getPurchases()).toHaveLength(1);
  });

  it("removes a receipt without touching others", () => {
    installStorage();
    recordPurchase({ listingId: "a", tx: "0x1", amountHbar: "1", seller: "s" });
    recordPurchase({ listingId: "b", tx: "0x2", amountHbar: "2", seller: "s" });
    removePurchase("0x1", "a");
    const list = getPurchases();
    expect(list).toHaveLength(1);
    expect(list[0].tx).toBe("0x2");
  });

  it("returns [] instead of throwing when storage is unavailable", () => {
    vi.stubGlobal("window", undefined);
    expect(getPurchases()).toEqual([]);
  });
});
