/**
 * GET /api/leaderboard/weekly tests — mirror node is fully stubbed.
 * Covers: weekly aggregation, human/agent filtering via the on-chain
 * Registry ownerType, username resolution, ordering, and graceful
 * degradation on mirror-node failure (never throws).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ethers } from "ethers";
import { TIPSENT_TOPIC } from "@/lib/leaderboard";

import { GET } from "./route";

const CODER = ethers.AbiCoder.defaultAbiCoder();

const HUMAN_EVM = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AGENT_EVM = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const UNKNOWN_EVM = "0xcccccccccccccccccccccccccccccccccccccccc";
const TIPPER_1 = "0xdddddddddddddddddddddddddddddddddddddddd";
const TIPPER_2 = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

function topicFor(addr: string): string {
  return "0x" + "0".repeat(24) + addr.slice(2).toLowerCase();
}

function tipLog(from: string, to: string, tinybar: bigint) {
  return {
    topics: [TIPSENT_TOPIC, "0x" + "0".repeat(64), topicFor(from), topicFor(to)],
    data: "0x" + tinybar.toString(16).padStart(64, "0") + "0".repeat(64),
    timestamp: "1757750400.000000000",
  };
}

function registerCalldata(username: string, ownerType: 0 | 1): string {
  return (
    "0xc02fdb27" +
    CODER.encode(
      ["string", "string", "uint8", "address", "string"],
      [username, "QmTest", ownerType, "0x0000000000000000000000000000000000000000", ""],
    ).slice(2)
  );
}

function stubMirrorNode() {
  const logs = [
    tipLog(TIPPER_1, HUMAN_EVM, 100_000_000n), // 1.0 HBAR
    tipLog(TIPPER_2, HUMAN_EVM, 50_000_000n), // 0.5 HBAR
    tipLog(TIPPER_1, AGENT_EVM, 1_000_000_000n), // 10 HBAR — must be excluded
    tipLog(TIPPER_2, UNKNOWN_EVM, 25_000_000n), // 0.25 HBAR — unresolvable page
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("/results/logs")) {
        return { ok: true, json: async () => ({ logs, links: { next: null } }) };
      }
      if (String(url).includes(`/results?from=${HUMAN_EVM}`)) {
        return {
          ok: true,
          json: async () => ({
            results: [{ function_parameters: registerCalldata("user-human", 0), error_message: null }],
          }),
        };
      }
      if (String(url).includes(`/results?from=${AGENT_EVM}`)) {
        return {
          ok: true,
          json: async () => ({
            results: [{ function_parameters: registerCalldata("agent-page", 1), error_message: null }],
          }),
        };
      }
      if (String(url).includes("/results?from=")) {
        return { ok: true, json: async () => ({ results: [] }) };
      }
      return { ok: false, json: async () => null };
    }),
  );
}

beforeEach(() => {
  stubMirrorNode();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/leaderboard/weekly", () => {
  it("aggregates the week's tips and excludes known agent pages", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      leaders: {
        rank: number;
        recipient: string;
        username: string | null;
        ownerType: string;
        totalHbar: string;
        tipCount: number;
        uniqueTippers: number;
      }[];
      windowDays: number;
    };

    expect(json.windowDays).toBe(7);
    // Agent (10 HBAR) excluded even though it tops raw totals
    expect(json.leaders.map((l) => l.recipient)).toEqual([HUMAN_EVM, UNKNOWN_EVM]);

    const [human, unknown] = json.leaders;
    expect(human).toMatchObject({
      rank: 1,
      username: "user-human",
      ownerType: "human",
      totalHbar: "1.5000",
      tipCount: 2,
      uniqueTippers: 2,
    });
    expect(unknown).toMatchObject({
      rank: 2,
      username: null,
      ownerType: "unknown",
      totalHbar: "0.2500",
      tipCount: 1,
      uniqueTippers: 1,
    });
  });

  it("returns an empty list with an error when the mirror node fails — never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => null })),
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { leaders: unknown[]; error?: string };
    expect(json.leaders).toEqual([]);
    expect(typeof json.error).toBe("string");
  });

  it("paginates bounded log pages (follows links.next)", async () => {
    const extra = tipLog(TIPPER_1, HUMAN_EVM, 100_000_000n);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).includes("/results/logs")) {
          const first = calls.filter((u) => u.includes("/results/logs")).length === 1;
          return {
            ok: true,
            json: async () =>
              first
                ? { logs: [extra], links: { next: "/api/v1/contracts/x/results/logs?cursor=2" } }
                : { logs: [], links: { next: null } },
          };
        }
        return { ok: true, json: async () => ({ results: [] }) };
      }),
    );
    const res = await GET();
    const json = (await res.json()) as { leaders: { totalHbar: string }[] };
    expect(calls.filter((u) => u.includes("/results/logs"))).toHaveLength(2);
    expect(json.leaders[0]!.totalHbar).toBe("1.0000");
  });
});
