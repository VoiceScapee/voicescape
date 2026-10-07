/** GET /api/townhall/market/delivery — verified-buyer file reveal. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  listing: null as null | { goodsType: string; ipfsHash: string | null },
  verified: false,
}));

vi.mock("@/lib/server/rate-limit", () => ({
  ipGate: async () => null,
}));

vi.mock("@/lib/server/townhall/handlers", () => ({
  defaultDeps: () => ({}),
  getListingById: async () => mocks.listing,
}));

vi.mock("@/lib/server/townhall/badges", () => ({
  verifyPurchase: async () => mocks.verified,
}));

import { GET } from "./route";

function getReq(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

describe("GET /api/townhall/market/delivery", () => {
  beforeEach(() => {
    mocks.listing = null;
    mocks.verified = false;
  });

  it("returns 400 without listingId and wallet", async () => {
    const res = await GET(getReq("http://localhost/api/townhall/market/delivery"));
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown listing", async () => {
    mocks.listing = null;
    const res = await GET(
      getReq("http://localhost/api/townhall/market/delivery?listingId=nope&wallet=0.0.1"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the listing has no digital file", async () => {
    mocks.listing = { goodsType: "digital", ipfsHash: null };
    const res = await GET(
      getReq("http://localhost/api/townhall/market/delivery?listingId=x&wallet=0.0.1"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when the wallet has no verified purchase", async () => {
    mocks.listing = { goodsType: "digital", ipfsHash: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" };
    mocks.verified = false;
    const res = await GET(
      getReq("http://localhost/api/townhall/market/delivery?listingId=x&wallet=0.0.1"),
    );
    expect(res.status).toBe(403);
  });

  it("returns the gateway URL for a verified buyer", async () => {
    const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    mocks.listing = { goodsType: "digital", ipfsHash: cid };
    mocks.verified = true;
    const res = await GET(
      getReq("http://localhost/api/townhall/market/delivery?listingId=x&wallet=0.0.1"),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string };
    expect(json.url).toBe(`https://ipfs.io/ipfs/${cid}`);
  });
});
