/** GET /api/townhall/market/purchases — chain-derived purchase history. */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/server/rate-limit", () => ({
  ipGate: async () => null,
}));

vi.mock("@/lib/server/townhall/handlers", () => ({
  defaultDeps: () => ({ hcs: {} }),
}));

vi.mock("@/lib/server/townhall/hcs", () => ({
  defaultHcsPort: () => ({}),
}));

vi.mock("@/lib/server/townhall/topics", () => ({
  getTopicId: () => null,
}));

vi.mock("@/lib/server/townhall/badges", () => ({
  walletPurchases: async () => [
    {
      listingRef: "sticker-pack",
      title: "Sticker Pack",
      tx: "0.0.1@1700000000.000000000",
      timestamp: "1700000000.000000000",
    },
  ],
}));

import { GET } from "./route";

function getReq(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

describe("GET /api/townhall/market/purchases", () => {
  it("returns 400 without a wallet", async () => {
    const res = await GET(getReq("http://localhost/api/townhall/market/purchases"));
    expect(res.status).toBe(400);
  });

  it("returns verified purchases for a wallet", async () => {
    const res = await GET(getReq("http://localhost/api/townhall/market/purchases?wallet=0.0.1"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      purchases: { listingRef: string; title: string; tx: string }[];
    };
    expect(json.purchases).toHaveLength(1);
    expect(json.purchases[0].listingRef).toBe("sticker-pack");
    expect(json.purchases[0].title).toBe("Sticker Pack");
  });
});
