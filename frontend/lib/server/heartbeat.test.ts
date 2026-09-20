/**
 * fetchHeartbeat tests: TipSent decoding, owner filtering, exact-string
 * cursor discipline, cold-start baseline (history never spikes), and
 * same-timestamp dedupe — all with a mocked mirror.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fetchHeartbeat, __resetHeartbeatState } from "./heartbeat";
import { TIPSENT_TOPIC } from "../leaderboard";

const OWNER_EVM = "0x" + "aa".repeat(20);
const OTHER_EVM = "0x" + "bb".repeat(20);
const TIPPER_EVM = "0x" + "cc".repeat(20);

function topicAddr(evm: string): string {
  return "0x" + "00".repeat(12) + evm.slice(2);
}

function tipData(grossTinybar: bigint, feeTinybar: bigint): string {
  const w = (n: bigint) => n.toString(16).padStart(64, "0");
  return "0x" + w(grossTinybar) + w(feeTinybar);
}

function tipLog(ts: string, to: string, gross: bigint, txHash: string, logIndex = 0) {
  return {
    address: "0x571d6d0c5d5ee7fc1e47283ad864305b7f7a88e0",
    timestamp: ts,
    data: tipData(gross, gross / 50n), // 2% fee
    topics: [TIPSENT_TOPIC, "0x" + "00".repeat(32), topicAddr(TIPPER_EVM), topicAddr(to)],
    transaction_hash: txHash,
    log_index: logIndex,
  };
}

const realFetch = globalThis.fetch;

function mockMirror(logs: unknown[]) {
  const seenUrls: string[] = [];
  globalThis.fetch = vi.fn(async (url: unknown) => {
    seenUrls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ logs }),
    };
  }) as unknown as typeof fetch;
  return seenUrls;
}

beforeEach(() => {
  __resetHeartbeatState();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe("fetchHeartbeat", () => {
  it("cold start: adopts the newest page as baseline and emits nothing", async () => {
    const seenUrls = mockMirror([
      tipLog("1789520539.844492534", OWNER_EVM, 500_000_000n, "0xhash1"),
    ]);
    const r = await fetchHeartbeat(OWNER_EVM);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("ok");
    // History is context, not news — a fresh server never spikes for it.
    expect(r.events).toEqual([]);
    expect(r.cursor).toBe("1789520539.844492534");
    // Cold start fetches the newest page (desc), not a 24h backfill.
    expect(seenUrls[0]).toContain("order=desc");
    expect(seenUrls[0]).not.toContain("timestamp=");
  });

  it("steady state: returns only the page owner's new tip events", async () => {
    vi.useFakeTimers();
    // Cold start establishes the baseline at ts …534.
    mockMirror([tipLog("1789520539.844492534", OWNER_EVM, 500_000_000n, "0xhash1")]);
    const cold = await fetchHeartbeat(OWNER_EVM);
    expect(cold.events).toEqual([]);

    // 11s later a new tip settles for the owner (and noise for others).
    vi.setSystemTime(Date.now() + 11_000);
    const seenUrls = mockMirror([
      tipLog("1789520539.844492534", OWNER_EVM, 500_000_000n, "0xhash1"),
      tipLog("1789520540.111111111", OTHER_EVM, 500_000_000n, "0xhash2"),
      tipLog("1789520541.222222222", OWNER_EVM, 500_000_000n, "0xhash3"),
    ]);
    const r = await fetchHeartbeat(OWNER_EVM);
    expect(r.ok).toBe(true);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].id).toBe("0xhash3");
    expect(r.events[0].type).toBe("tip");
    // 500M tinybar − 2% fee = 490M tinybar = 4.9 HBAR net.
    expect(r.events[0].amountTinybar).toBe("490000000");
    expect(r.events[0].amountHbar).toBeCloseTo(4.9, 10);
    expect(r.events[0].txHash).toBe("0xhash3");
    // Steady state pages forward with the exact-string gte: cursor.
    expect(seenUrls[0]).toContain(
      `timestamp=gte:${encodeURIComponent("1789520539.844492534")}`,
    );
    // The exact-string cursor is never float-mangled in the request.
    expect(seenUrls[0]).not.toContain("1789520539.8444924&");
  });

  it("filters by topic0 in code: non-TipSent logs in the unfiltered response are ignored", async () => {
    vi.useFakeTimers();
    mockMirror([]);
    await fetchHeartbeat(OWNER_EVM); // cold start, empty
    vi.setSystemTime(Date.now() + 11_000);
    // Mirror topic query filters silently match nothing on this endpoint,
    // so the fetch is unfiltered and other contract events must not spike.
    const other = {
      ...tipLog("1789520539.844492534", OWNER_EVM, 100_000_000n, "0xother"),
      topics: [
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x" + "00".repeat(32),
        topicAddr(TIPPER_EVM),
        topicAddr(OWNER_EVM),
      ],
    };
    mockMirror([other]);
    const r = await fetchHeartbeat(OWNER_EVM);
    expect(r.events).toEqual([]);
    // ...but the cursor still advances past it.
    expect(r.cursor).toBe("1789520539.844492534");
  });

  it("accepts 0.0.x account ids and canonicalizes them", async () => {
    mockMirror([]);
    const r = await fetchHeartbeat("0.0.170");
    expect(r.error).not.toBe("bad-wallet");
    expect(r.wallet).toBe("0x00000000000000000000000000000000000000aa");
  });

  it("rejects malformed wallets", async () => {
    const r = await fetchHeartbeat("not-a-wallet");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("bad-wallet");
  });

  it("dedupes by id across polls and never skips same-timestamp logs", async () => {
    vi.useFakeTimers();
    const ts = "1789520539.844492534";
    const logA = tipLog(ts, OWNER_EVM, 100_000_000n, "0xhashA", 0);
    const logB = tipLog(ts, OWNER_EVM, 200_000_000n, "0xhashB", 1);

    // Cold start: baseline adopted silently.
    mockMirror([logA]);
    const cold = await fetchHeartbeat(OWNER_EVM);
    expect(cold.events).toEqual([]);

    // Poll 2: log B arrives sharing log A's timestamp. gte: must not skip
    // it, and A must be deduped by id.
    vi.setSystemTime(Date.now() + 11_000);
    const seenUrls = mockMirror([logA, logB]);
    const p2 = await fetchHeartbeat(OWNER_EVM);
    expect(p2.events.map((e) => e.id)).toEqual(["0xhashB"]);
    expect(seenUrls[0]).toContain(`timestamp=gte:${encodeURIComponent(ts)}`);
  });

  it("goes offline with no cache when the mirror fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await fetchHeartbeat(OWNER_EVM);
    expect(r.status).toBe("offline");
    expect(r.events).toEqual([]);
  });

  it("serves a degraded answer from recent cache when the mirror fails", async () => {
    vi.useFakeTimers();
    mockMirror([tipLog("1789520539.844492534", OWNER_EVM, 100_000_000n, "0xhash1")]);
    const cold = await fetchHeartbeat(OWNER_EVM);
    expect(cold.status).toBe("ok");
    expect(cold.events).toEqual([]);

    // 11s later the cache is stale for serving but fresh enough to degrade.
    vi.setSystemTime(Date.now() + 11_000);
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const degraded = await fetchHeartbeat(OWNER_EVM);
    expect(degraded.status).toBe("degraded");
    expect(degraded.cached).toBe(true);
    expect(degraded.error).toBe("mirror-unreachable");
  });

  it("serves cached results within the TTL without a second mirror hit", async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ logs: [] }),
    }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await fetchHeartbeat(OWNER_EVM);
    const second = await fetchHeartbeat(OWNER_EVM);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
  });
});
