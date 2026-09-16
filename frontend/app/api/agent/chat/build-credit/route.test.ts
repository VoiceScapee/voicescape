/**
 * GET /api/agent/chat/build-credit tests: the widget's build-credit status
 * check answers ONLY about the caller's own session wallet — never any
 * other wallet's data. Anonymous/invalid sessions learn nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AbiCoder } from "ethers";

import { GET } from "./route";
import { resetBuildCreditRateLimit } from "@/lib/agent/rate-limit";
import { issueSessionToken } from "@/lib/server/townhall/auth";

// Forge fixture: 0.0.10862061, AGENT
const FORGE_EVM = "0x5274e1499d145d6f4984661203bf65c2bed7f8ce";
const OPERATOR_EVM = "0x0000000000000000000000000000000000000001";

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as any;
}

/** Mirror-node fetch mock: serves tip-log batches to /results/logs. */
function mockMirror(mirrorBatches: unknown[][]) {
  const impl = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes("/results/logs")) {
      const batch = mirrorBatches.shift() ?? [];
      return jsonResponse({ logs: batch });
    }
    if (u.includes("/contracts/call")) {
      return jsonResponse({
        result: AbiCoder.defaultAbiCoder().encode(
          ["address", "string", "uint8", "address", "string"],
          [FORGE_EVM, "QmTestHash", 1, OPERATOR_EVM, "test purpose"]
        ),
      });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

function get(headers: Record<string, string> = {}, ip = "9.9.9.1") {
  return new NextRequest("http://localhost/api/agent/chat/build-credit", {
    method: "GET",
    headers: { "x-forwarded-for": ip, ...headers },
  });
}

function sessionHeaders(evm: string): Record<string, string> {
  const token = issueSessionToken(
    {
      address: evm,
      chainId: 295,
      nonce: "cc".repeat(16),
      expiresAtMs: Date.now() + 86_400_000,
    },
    Date.now()
  );
  return { "x-vs-session": token };
}

/** One qualifying 5-HBAR TipSent log for the forge page. */
function tipLog(timestamp: string, index: number) {
  const amount = (5_000_000_000_000_000_000n).toString(16).padStart(64, "0");
  const fee = (100_000_000_000_000_000n).toString(16).padStart(64, "0");
  return { data: "0x" + amount + fee, timestamp, transaction_index: index };
}

const EVM_PAID = "0x1111111111111111111111111111111111111111";
const EVM_UNPAID = "0x2222222222222222222222222222222222222222";

beforeEach(() => {
  resetBuildCreditRateLimit();
  vi.stubEnv("SESSION_SECRET", "credit-test-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/agent/chat/build-credit", () => {
  it("anonymous callers learn nothing about anyone's credit", async () => {
    mockMirror([]);
    const res = await GET(get());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ signedIn: false, hasCredit: false });
  });

  it("rejects a forged session token", async () => {
    mockMirror([]);
    const res = await GET(
      get({ "x-vs-session": "not-a-real-token" }, "9.9.9.2")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ signedIn: false, hasCredit: false });
  });

  it("reports unpaid for a signed-in wallet with no 5-HBAR payment", async () => {
    mockMirror([[/* no tips */]]);
    const res = await GET(get(sessionHeaders(EVM_UNPAID), "9.9.9.3"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ signedIn: true, hasCredit: false });
  });

  it("reports credit for a signed-in wallet with an unused payment", async () => {
    mockMirror([[tipLog("1789520700.123456789", 11)]]);
    const res = await GET(get(sessionHeaders(EVM_PAID), "9.9.9.4"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ signedIn: true, hasCredit: true });
  });

  it("queries the mirror node with a bounded timestamp range (topic search requirement)", async () => {
    // Verified 2026-09-16 against mainnet: /contracts/{id}/results/logs
    // silently returns zero logs for topic searches without a bounded
    // timestamp range (strictly under 7d). Without the range a paid build
    // would never be credited.
    const fetchImpl = mockMirror([[/* no tips */]]);
    const res = await GET(get(sessionHeaders(EVM_UNPAID), "9.9.9.6"));
    expect(res.status).toBe(200);
    const logUrls = fetchImpl.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/results/logs"));
    expect(logUrls.length).toBeGreaterThan(0);
    for (const u of logUrls) {
      expect(u).toMatch(/timestamp=gte:\d+\.\d+/);
      expect(u).toMatch(/timestamp=lte:\d+\.\d+/);
      const gte = Number(u.match(/timestamp=gte:(\d+)\./)?.[1] ?? "0");
      const lte = Number(u.match(/timestamp=lte:(\d+)\./)?.[1] ?? "0");
      expect(lte - gte).toBeGreaterThan(0);
      expect(lte - gte).toBeLessThan(7 * 24 * 3600);
    }
  });

  it("never exposes another wallet's credit (no address parameter is honored)", async () => {
    // Even if a caller appends ?wallet=<paid> to the URL, the endpoint only
    // reads the session token — an anonymous caller still learns nothing.
    mockMirror([[tipLog("1789520701.123456789", 12)]]);
    const req = new NextRequest(
      `http://localhost/api/agent/chat/build-credit?wallet=${EVM_PAID}`,
      { method: "GET", headers: { "x-forwarded-for": "9.9.9.5" } }
    );
    const res = await GET(req);
    const body = await res.json();
    expect(body).toEqual({ signedIn: false, hasCredit: false });
  });

  it("rate-limits repeated polling", async () => {
    mockMirror([]);
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) {
      last = await GET(get(sessionHeaders(EVM_UNPAID), "9.9.9.6"));
    }
    expect(last!.status).toBe(429);
  });

  it("fails closed with 503 when the store is unreachable", async () => {
    // A store failure must never be reported as "unpaid" — the widget
    // would hide the pay button for a wallet that actually paid.
    mockMirror([]);
    const storeModule = await import("@/lib/server/store");
    const failing = {
      get: async () => {
        throw new Error("store down");
      },
      set: async () => {},
      setNx: async () => false,
      del: async () => {},
      incr: async () => 0,
      clearPrefix: async () => {},
    };
    const spy = vi
      .spyOn(storeModule, "getKvStore")
      .mockReturnValue(failing as any);
    try {
      const res = await GET(get(sessionHeaders(EVM_UNPAID), "9.9.9.7"));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ error: "credit_unavailable" });
    } finally {
      spy.mockRestore();
    }
  });
});
