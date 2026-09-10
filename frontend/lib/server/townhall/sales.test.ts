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
  it("returns false without throwing when the Tips contract is not deployed", async () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", "");
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      seen.push(String(url));
      return jsonResponse(200, { logs: [] });
    });
    const port = new RealSalesPort();
    await expect(port.hasCompletedPurchase(BUYER, SELLER)).resolves.toBe(false);
    expect(seen).toHaveLength(0); // no mirror call at all
  });

  it("queries the Tips contract for PurchaseCompleted logs with buyer/seller topics", async () => {
    vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", TIPS);
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      seen.push(String(url));
      return jsonResponse(200, { logs: [] });
    });
    const port = new RealSalesPort();
    await expect(port.hasCompletedPurchase(BUYER, SELLER)).resolves.toBe(false);
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]);
    expect(url.pathname).toContain(`/api/v1/contracts/${TIPS}/results/logs`);
    expect(url.searchParams.get("topic0")).toBe(EXPECTED_TOPIC0);
    expect(url.searchParams.get("topic1")).toBe(
      "0x" + BUYER.slice(2).toLowerCase().padStart(64, "0"),
    );
    expect(url.searchParams.get("topic2")).toBe(
      "0x" + SELLER.slice(2).toLowerCase().padStart(64, "0"),
    );
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
