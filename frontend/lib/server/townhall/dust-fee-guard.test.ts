/**
 * Dust-fee economics guard tests (lib/server/townhall/handlers.ts).
 *
 * The operator's key pays every HCS submit while the dust fee goes to the
 * treasury. The economics guard must fail LOUD (503) when the configured
 * fee is 0 or below the operator cost floor, and let a sufficient fee
 * proceed to normal verification.
 *
 * No network: minimal stubbed deps.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createPost, type TownhallDeps } from "./handlers";
import { MemoryHcsClient } from "./hcs";
import { clearConsumedDustFees } from "./mirror";
import type { AuthPort, VerifiedSession } from "./auth";
import type { MirrorPort } from "./mirror";
import type { RegistryPort } from "./registry-check";
import type { SalesPort } from "./sales";

// Use the REAL default submit-cost floor: make sure no other test file's
// env tuning leaks in (vitest isolates files, this is belt-and-braces).
delete process.env.HCS_SUBMIT_FEE_TINYBARS;

process.env.TOWNHALL_TOPIC_FORUM = "0.0.7001";
process.env.DUST_FEE_TINYBARS = "2000000";

const BRANDON: VerifiedSession = {
  address: "0x000000000000000000000000000000000000b001",
  chainId: 296,
  nonce: "test",
  expiresAtMs: Date.now() + 3600_000,
};

beforeEach(async () => {
  await clearConsumedDustFees();
});

function makeDeps(feeTinybars: number): TownhallDeps {
  const mirror: MirrorPort = {
    verifyDustFee: async () => ({ ok: true, reason: "ok", receivedTinybars: feeTinybars }),
    feeInfo: () => ({ dustFeeTinybars: feeTinybars, treasury: "0.0.999" }),
  };
  const registry: RegistryPort = {
    isRegistered: async (u) => u.trim().toLowerCase() === "brandon",
    resolveOwner: async (u) =>
      u.trim().toLowerCase() === "brandon" ? BRANDON.address : null,
  };
  const auth: AuthPort = {
    verifySession: async () => ({ ok: true, session: BRANDON }),
  };
  const sales: SalesPort = {
    hasCompletedPurchase: async () => false,
  };
  return { hcs: new MemoryHcsClient(), mirror, registry, auth, sales };
}

let feeSeq = 0;
function body(dustFeeTxId?: string) {
  return {
    auth: {},
    author: "brandon",
    board: "general",
    body: "hello town hall",
    ...(dustFeeTxId ? { dustFeeTxId } : {}),
  };
}

describe("dust-fee economics guard", () => {
  it("fee = 0 → 503 disabled, writes never reach verification", async () => {
    const r = await createPost(makeDeps(0), body("0.0.1@1694000000.000000000"));
    expect(r.status).toBe(503);
    const j = r.json as { error: string };
    expect(j.error).toMatch(/not configured/i);
    expect(j.error).toMatch(/cannot subsidize/i);
  });

  it("fee below the operator cost floor → 503 naming fee and floor", async () => {
    // Default submit cost is 100k tinybars; floor is 2x = 200k. 150k is a
    // "real" fee that would still lose the operator money.
    const r = await createPost(makeDeps(150_000), body("0.0.1@1694000001.000000000"));
    expect(r.status).toBe(503);
    const j = r.json as { error: string };
    expect(j.error).toBe(
      "dust fee (150000 tinybars) is below the operator cost floor (200000 tinybars) — raise DUST_FEE_TINYBARS",
    );
  });

  it("fee exactly at the floor passes the guard to normal verification (402 without a tx)", async () => {
    const r = await createPost(makeDeps(200_000), body());
    expect(r.status).toBe(402);
    const j = r.json as { error: string };
    expect(j.error).toMatch(/dust fee required/i);
  });

  it("fee above the floor proceeds: a verified fee buys one write (201)", async () => {
    const r = await createPost(makeDeps(2_000_000), body(`0.0.1@1694000002.00000000${++feeSeq}`));
    expect(r.status).toBe(201);
  });

  it("the floor follows HCS_SUBMIT_FEE_TINYBARS when set", async () => {
    process.env.HCS_SUBMIT_FEE_TINYBARS = "50";
    try {
      // Floor is now 100 tinybars: a 500-tinybar fee passes the guard.
      const ok = await createPost(makeDeps(500), body());
      expect(ok.status).toBe(402); // past the guard, into normal 402
      // And a 50-tinybar fee is below the new floor.
      const bad = await createPost(makeDeps(50), body());
      expect(bad.status).toBe(503);
    } finally {
      delete process.env.HCS_SUBMIT_FEE_TINYBARS;
    }
  });
});
