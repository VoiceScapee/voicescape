/** Builder badge tests — mocked Mirror Node, in-memory KV. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import {
  BUILDERS_ROOM_ID,
  BUILDER_UNLOCK_MESSAGE,
  builderBadgeProgress,
  clearBuilderBadgeCache,
  hasBuilderBadge,
} from "./badges";

const WALLET = "0x000000000000000000000000000000000000a11c";
const TIPS = "0.0.10854060";
const REGISTRY = "0.0.10854058";

// Real event topic hashes — the code filters by topic in code because the
// mirror node ignores topic query filters (verified 2026-09-13).
const TIPSENT_TOPIC0 = ethers.id("TipSent(string,address,address,uint256,uint256)");
const PAGE_REGISTERED_TOPIC0 = ethers.id("PageRegistered(string,address,string,uint8,address,string)");
const WALLET_TOPIC = "0x" + "000000000000000000000000000000000000a11c".padStart(64, "0");
const ZERO_TOPIC = "0x" + "0".repeat(64);

/** Scenario flags for the fetch mock. */
let scenario = { hasPage: false, hasTip: false, fail: false };

function mockLogsResponse(url: string): { logs: unknown[] } {
  if (scenario.fail) throw new Error("mirror down");
  const u = String(url);
  const isRegistry = u.includes(`/contracts/${REGISTRY}/results/logs`);
  const isTips = u.includes(`/contracts/${TIPS}/results/logs`);
  // ownsRegisteredPage: a PageRegistered log for the wallet (owner = topic2).
  if (isRegistry)
    return {
      logs: scenario.hasPage ? [{ topics: [PAGE_REGISTERED_TOPIC0, ZERO_TOPIC, WALLET_TOPIC] }] : [],
    };
  // countPaymentsReceived: a TipSent to the wallet (toOwner = topic3).
  if (isTips)
    return {
      logs: scenario.hasTip ? [{ topics: [TIPSENT_TOPIC0, ZERO_TOPIC, ZERO_TOPIC, WALLET_TOPIC] }] : [],
    };
  return { logs: [] };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_TIPS_ADDRESS", TIPS);
  vi.stubEnv("NEXT_PUBLIC_REGISTRY_ADDRESS", REGISTRY);
  vi.stubEnv("TOWNHALL_HCS_NETWORK", "mainnet");
  scenario = { hasPage: false, hasTip: false, fail: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => mockLogsResponse(url),
    })),
  );
  return clearBuilderBadgeCache(WALLET);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("hasBuilderBadge", () => {
  it("is true when the wallet owns a page and received a tip", async () => {
    scenario = { hasPage: true, hasTip: true, fail: false };
    expect(await hasBuilderBadge(WALLET)).toBe(true);
  });

  it("is false when the wallet owns a page but got no tip", async () => {
    scenario = { hasPage: true, hasTip: false, fail: false };
    expect(await hasBuilderBadge(WALLET)).toBe(false);
  });

  it("is false when the wallet got a tip but owns no page", async () => {
    scenario = { hasPage: false, hasTip: true, fail: false };
    expect(await hasBuilderBadge(WALLET)).toBe(false);
  });

  it("is false for an invalid wallet address", async () => {
    expect(await hasBuilderBadge("not-a-wallet")).toBe(false);
  });

  it("accepts the 0.0.x account form", async () => {
    scenario = { hasPage: true, hasTip: true, fail: false };
    // 0x...a11c = 0.0.41244
    expect(await hasBuilderBadge("0.0.41244")).toBe(true);
  });

  it("fails closed when the mirror node is down", async () => {
    scenario = { hasPage: true, hasTip: true, fail: true };
    expect(await hasBuilderBadge(WALLET)).toBe(false);
  });

  it("caches the result for an hour (no second fetch)", async () => {
    scenario = { hasPage: true, hasTip: true, fail: false };
    expect(await hasBuilderBadge(WALLET)).toBe(true);
    const callsAfterFirst = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    // Flip the world: page sold, tips gone — cache must still say true.
    scenario = { hasPage: false, hasTip: false, fail: false };
    expect(await hasBuilderBadge(WALLET)).toBe(true);
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsAfterFirst);
  });
});

describe("founder bypass", () => {
  const FOUNDER_ID = "0.0.10424063";
  const FOUNDER_EVM = "0x00000000000000000000000000000000009f0eff"; // long-zero session form

  it("grants the founder the badge without any on-chain activity", async () => {
    scenario = { hasPage: false, hasTip: false, fail: false };
    expect(await hasBuilderBadge(FOUNDER_ID)).toBe(true);
  });

  it("grants the founder the badge in long-zero EVM form (session address)", async () => {
    scenario = { hasPage: false, hasTip: false, fail: false };
    expect(await hasBuilderBadge(FOUNDER_EVM)).toBe(true);
  });

  it("grants the founder full progress even when the mirror node is down", async () => {
    scenario = { hasPage: false, hasTip: false, fail: true };
    expect(await builderBadgeProgress(FOUNDER_ID)).toEqual({
      hasPage: true,
      hasTip: true,
      complete: true,
    });
  });

  it("makes no network calls for the founder", async () => {
    scenario = { hasPage: false, hasTip: false, fail: false };
    const calls = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await hasBuilderBadge(FOUNDER_ID);
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
  });

  it("does not grant a neighboring account the bypass", async () => {
    scenario = { hasPage: false, hasTip: false, fail: false };
    expect(await hasBuilderBadge("0.0.10424064")).toBe(false);
  });
});

describe("builderBadgeProgress", () => {
  it("reports 1/2 goals with per-goal flags", async () => {
    scenario = { hasPage: true, hasTip: false, fail: false };
    expect(await builderBadgeProgress(WALLET)).toEqual({ hasPage: true, hasTip: false, complete: false });
  });

  it("reports 2/2 when complete", async () => {
    scenario = { hasPage: true, hasTip: true, fail: false };
    expect(await builderBadgeProgress(WALLET)).toEqual({ hasPage: true, hasTip: true, complete: true });
  });
});

describe("builders room constants", () => {
  it("uses the reserved room id", () => {
    expect(BUILDERS_ROOM_ID).toBe("builders");
  });

  it("unlock message tells the user exactly what to do", () => {
    expect(BUILDER_UNLOCK_MESSAGE).toContain("publish a blockpage");
    expect(BUILDER_UNLOCK_MESSAGE).toContain("first tip");
  });
});
