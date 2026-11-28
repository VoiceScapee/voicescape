/**
 * RealSalesPort tests: reputation proof-of-payment comes from
 * PurchaseCompleted event logs on the Tips contract — no escrow involved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import { RealSalesPort } from "./sales";

const TIPS = "0x000000000000000000000000000000000000a11c";
const BUYER = "0x0000000000000000000000000000000000000b0b";
const SELLER = "0x0000000000000000000000000000000000000c3c";

const EXPECTED_TOPIC0 = ethers.id(
  "PurchaseCompleted(address,address,string,uint256,uint256)",
);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("RealSalesPort", () => {
  it("uses the mainnet fallback when the Tips address is unset (makes mirror call)", async () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", "");
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      seen.push(String(url));
      return jsonResponse(200, { logs: [] });
    });
    const port = new RealSalesPort();
    await expect(port.hasCompletedPurchase(BUYER, SELLER)).resolves.toBe(false);
    expect(seen.length).toBeGreaterThan(0); // mirror call happens with mainnet fallback
  });

  it("queries the Tips contract for PurchaseCompleted logs with buyer/seller topics, windowed so the mirror node accepts it", async () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", TIPS);
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      seen.push(String(url));
      return jsonResponse(200, { logs: [] });
    });
    const port = new RealSalesPort();
    await expect(port.hasCompletedPurchase(BUYER, SELLER)).resolves.toBe(false);
    // The mirror node rejects topic filters without a timestamp range,
    // and ranges wider than 7 days ("within 7d") — every window must be
    // a valid ≤6-day range. Clearance second pass, 2026-11-28, finding D.
    expect(seen.length).toBeGreaterThan(1);
    // Promise.all runs the windows concurrently, so seen order is
    // arbitrary — sort by window start before checking the tiling.
    const windows = seen
      .map((raw) => {
        const url = new URL(raw);
        expect(url.pathname).toContain(`/api/v1/contracts/${TIPS}/results/logs`);
        expect(url.searchParams.get("topic0")).toBe(EXPECTED_TOPIC0);
        expect(url.searchParams.get("topic1")).toBe(
          "0x" + BUYER.slice(2).toLowerCase().padStart(64, "0"),
        );
        expect(url.searchParams.get("topic2")).toBe(
          "0x" + SELLER.slice(2).toLowerCase().padStart(64, "0"),
        );
        const ts = url.searchParams.getAll("timestamp");
        return {
          gte: Number(ts.find((t) => t.startsWith("gte:"))?.slice(4)),
          lte: Number(ts.find((t) => t.startsWith("lte:"))?.slice(4)),
        };
      })
      .sort((a, b) => a.gte - b.gte);
    let prevLte = -1;
    for (const { gte, lte } of windows) {
      expect(Number.isFinite(gte) && Number.isFinite(lte)).toBe(true);
      expect(lte - gte).toBeLessThanOrEqual(6 * 24 * 60 * 60);
      if (prevLte !== -1) expect(gte).toBe(prevLte); // windows tile with no gap
      prevLte = lte;
    }
    // Windows start at the first Tips log (2026-09-01) and run to now.
    expect(windows[0].gte).toBe(1788220800);
  });

  it("returns true when any matching log exists (the event proves the atomic 98/2 transfer)", async () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", TIPS);
    vi.stubGlobal("fetch", async () =>
      jsonResponse(200, { logs: [{ topics: [EXPECTED_TOPIC0] }] }),
    );
    const port = new RealSalesPort();
    await expect(port.hasCompletedPurchase(BUYER, SELLER)).resolves.toBe(true);
  });

  it("throws on mirror-node failure so callers fail closed", async () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", TIPS);
    vi.stubGlobal("fetch", async () => jsonResponse(500, { error: "boom" }));
    const port = new RealSalesPort();
    await expect(port.hasCompletedPurchase(BUYER, SELLER)).rejects.toThrow(/mirror node error/);
  });
});
