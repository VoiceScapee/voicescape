/**
 * GET /api/heartbeat tests — the Blockchain Heartbeat endpoint contract.
 * The mirror logic itself is covered in lib/server/heartbeat.test.ts;
 * here we check shapes + status codes.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/server/heartbeat", () => ({
  fetchHeartbeat: vi.fn(),
}));
vi.mock("@/lib/server/rate-limit", () => ({
  ipGate: vi.fn(),
}));

import { GET } from "./route";
import { fetchHeartbeat } from "@/lib/server/heartbeat";
import { ipGate } from "@/lib/server/rate-limit";

const mockFetchHeartbeat = vi.mocked(fetchHeartbeat);
const mockIpGate = vi.mocked(ipGate);

function getReq(wallet: string): NextRequest {
  return new NextRequest(`http://localhost/api/heartbeat?wallet=${encodeURIComponent(wallet)}`);
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockIpGate.mockResolvedValue(null);
});

describe("GET /api/heartbeat", () => {
  it("returns 200 with the heartbeat result", async () => {
    mockFetchHeartbeat.mockResolvedValue({
      ok: true,
      status: "ok",
      wallet: "0x" + "aa".repeat(20),
      cursor: "1789520539.844492534",
      checkedAt: 1_789_520_540_000,
      cached: false,
      slow: false,
      events: [],
    });
    const res = await GET(getReq("0x" + "aa".repeat(20)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.events).toEqual([]);
  });

  it("returns 400 for a malformed wallet", async () => {
    mockFetchHeartbeat.mockResolvedValue({
      ok: false,
      status: "offline",
      wallet: "",
      cursor: null,
      checkedAt: 0,
      cached: false,
      slow: false,
      events: [],
      error: "bad-wallet",
    });
    const res = await GET(getReq("not-a-wallet"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/wallet must be/);
  });

  it("passes through degraded/offline results as 200 (never 503)", async () => {
    mockFetchHeartbeat.mockResolvedValue({
      ok: true,
      status: "offline",
      wallet: "0x" + "aa".repeat(20),
      cursor: null,
      checkedAt: 1_789_520_540_000,
      cached: false,
      slow: false,
      events: [],
      error: "mirror-unreachable",
    });
    const res = await GET(getReq("0x" + "aa".repeat(20)));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("offline");
  });

  it("returns the rate-limit gate's response when gated", async () => {
    mockIpGate.mockResolvedValue(
      NextResponse.json({ error: "slow down" }, { status: 429 }),
    );
    const res = await GET(getReq("0x" + "aa".repeat(20)));
    expect(res.status).toBe(429);
    expect(mockFetchHeartbeat).not.toHaveBeenCalled();
  });
});
