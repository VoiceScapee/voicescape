/**
 * Tests for fetchEarningsSummary (lib/server/earnings.ts): mirror-node
 * reads with an injectable fetch, so the aggregation windows and failure
 * modes are exercised without hitting Hedera.
 */
import { describe, expect, it } from "vitest";
import { fetchEarningsSummary } from "./earnings";
import { TIPSENT_TOPIC } from "../leaderboard";

const OWNER = "0x" + "aa".repeat(20);
const TIPPER_A = "0x" + "bb".repeat(20);
const TIPPER_B = "0x" + "cc".repeat(20);
const OTHER = "0x" + "dd".repeat(20);
const USERNAME_HASH = "0x" + "11".repeat(32);

// Fixed "now" so windows are deterministic: 2026-09-13T12:00:00Z.
const NOW_MS = Date.UTC(2026, 8, 13, 12, 0, 0);
const D = 86_400;

function topic(addr: string): string {
  return "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
}

function data(amountTinybar: bigint): string {
  return "0x" + amountTinybar.toString(16).padStart(64, "0") + "0".repeat(64);
}

function tipLog(from: string, to: string, hbar: number, atSec: number) {
  return {
    topics: [TIPSENT_TOPIC, USERNAME_HASH, topic(from), topic(to)],
    data: data(BigInt(Math.round(hbar * 100_000_000))),
    timestamp: `${atSec}.000000000`,
  };
}

/** Mirror-node JSON body with one page of logs. */
function body(logs: unknown[], next: string | null = null): string {
  return JSON.stringify({ logs, links: { next } });
}

type MockFetch = (url: string, init?: RequestInit) => Promise<Response>;

function okFetch(logs: unknown[], next: string | null = null): MockFetch {
  return async () => new Response(body(logs, next), { status: 200 });
}

function seqFetch(pages: { logs: unknown[]; next: string | null }[]): MockFetch {
  let i = 0;
  return async () => {
    const page = pages[Math.min(i, pages.length - 1)];
    i++;
    return new Response(body(page.logs, page.next), { status: 200 });
  };
}

describe("fetchEarningsSummary", () => {
  it("aggregates 7d / 30d / all-time for the owner only", async () => {
    const now = Math.floor(NOW_MS / 1000);
    const logs = [
      tipLog(TIPPER_A, OWNER, 1, now - 3 * D), // 7d + 30d
      tipLog(TIPPER_B, OWNER, 2, now - 10 * D), // 30d only
      tipLog(TIPPER_A, OWNER, 4, now - 40 * D), // all-time only
      tipLog(TIPPER_A, OTHER, 999, now - D), // someone else's tip
    ];
    const r = await fetchEarningsSummary(OWNER, { fetcher: okFetch(logs), nowMs: NOW_MS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.address).toBe(OWNER);
    expect(r.summary.hbar7d).toBeCloseTo(1, 8);
    expect(r.summary.hbar30d).toBeCloseTo(3, 8);
    expect(r.summary.hbarAllTime).toBeCloseTo(7, 8);
    expect(r.summary.tipCount7d).toBe(1);
    expect(r.summary.tipCount30d).toBe(2);
    expect(r.summary.uniqueTippers30d).toBe(2);
    expect(r.allTimeTruncated).toBe(false);
  });

  it("skips non-TipSent logs and malformed entries", async () => {
    const now = Math.floor(NOW_MS / 1000);
    const logs = [
      { topics: ["0xdeadbeef"], data: "0x", timestamp: `${now}.000000000` },
      { topics: [TIPSENT_TOPIC, USERNAME_HASH], data: "0x", timestamp: `${now}.000000000` },
      tipLog(TIPPER_A, OWNER, 0.5, now - D),
    ];
    const r = await fetchEarningsSummary(OWNER, { fetcher: okFetch(logs), nowMs: NOW_MS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.hbar7d).toBeCloseTo(0.5, 8);
    expect(r.summary.tipCount30d).toBe(1);
  });

  it("follows mirror-node pagination", async () => {
    const now = Math.floor(NOW_MS / 1000);
    const r = await fetchEarningsSummary(OWNER, {
      fetcher: seqFetch([
        { logs: [tipLog(TIPPER_A, OWNER, 1, now - D)], next: "/api/v1/contracts/x/results/logs?cursor=2" },
        { logs: [tipLog(TIPPER_B, OWNER, 2, now - D)], next: null },
      ]),
      nowMs: NOW_MS,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.hbar30d).toBeCloseTo(3, 8);
    expect(r.summary.tipCount30d).toBe(2);
    expect(r.allTimeTruncated).toBe(false);
  });

  it("returns a graceful failure when the mirror node errors", async () => {
    const failing: MockFetch = async () => new Response("boom", { status: 500 });
    const r = await fetchEarningsSummary(OWNER, { fetcher: failing, nowMs: NOW_MS });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBeTruthy();
  });

  it("returns a graceful failure when the network throws", async () => {
    const throwing: MockFetch = async () => {
      throw new Error("network down");
    };
    const r = await fetchEarningsSummary(OWNER, { fetcher: throwing, nowMs: NOW_MS });
    expect(r.ok).toBe(false);
  });

  it("accepts uppercase addresses and normalizes them", async () => {
    const now = Math.floor(NOW_MS / 1000);
    const logs = [tipLog(TIPPER_A, OWNER, 1, now - D)];
    const r = await fetchEarningsSummary(OWNER.toUpperCase(), { fetcher: okFetch(logs), nowMs: NOW_MS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.address).toBe(OWNER);
    expect(r.summary.hbar7d).toBeCloseTo(1, 8);
  });
});
