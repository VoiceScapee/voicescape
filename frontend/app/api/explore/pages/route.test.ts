/**
 * GET /api/explore/pages tests.
 *
 * Regression focus: an earlier version scanned only the 20 newest registry
 * logs and decoded the first 10, so older pages were silently crowded out of
 * Explore by other users' re-publish (PageUpdated) events. These tests pin
 * the fixed behavior: EVERY PageRegistered event yields a page, no matter
 * how many newer PageUpdated events exist.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import { AbiCoder } from "ethers";

import { GET } from "./route";
import { PAGEREGISTERED_TOPIC, PAGEUPDATED_TOPIC } from "@/lib/registry-topics";

/** Minimal NextRequest stub — the route only reads nextUrl.searchParams. */
function mockReq(sort?: string): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(sort ? { sort } : {}) },
  } as unknown as NextRequest;
}

const realFetch = globalThis.fetch;

const coder = AbiCoder.defaultAbiCoder();

/**
 * Real ABI encoding of registerPage(username, ipfsHash, ownerType, operator,
 * purpose) with the on-chain selector — decodePageFromCalldata validates the
 * selector and decodes the ownerType uint8, exactly like production.
 */
function encodeRegisterCall(username: string, ownerType: 0 | 1 = 0): string {
  return (
    "0xc02fdb27" +
    coder
      .encode(
        ["string", "string", "uint8", "address", "string"],
        [
          username,
          "QmTestHash",
          ownerType,
          "0x0000000000000000000000000000000000000001",
          "test purpose",
        ],
      )
      .slice(2)
  );
}

function log(timestamp: string, topic: string, owner = "fc1177680ecf347f06cf3c086fa58ca2713fb462") {
  return {
    timestamp,
    topics: [topic, "0x" + "ab".repeat(32), "0x" + "00".repeat(12) + owner],
  };
}

interface MockSetup {
  /** timestamp -> registration (username + on-chain owner type) */
  registrations: Record<string, { username: string; ownerType: 0 | 1 }>;
  /** log pages returned by the logs endpoint, in order */
  logPages: { logs: ReturnType<typeof log>[]; next?: string }[];
  failLogs?: boolean;
}

function mockMirrorNode(setup: MockSetup) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/results/logs")) {
      if (setup.failLogs) throw new Error("mirror down");
      const pageIdx = url.includes("page=2") ? 1 : 0;
      const page = setup.logPages[pageIdx] ?? { logs: [] };
      return {
        ok: true,
        json: async () => ({
          logs: page.logs,
          links: page.next ? { next: page.next } : {},
        }),
      };
    }
    if (url.includes("/transactions?timestamp=")) {
      const ts = url.split("timestamp=")[1];
      return {
        ok: true,
        json: async () => ({ transactions: [{ transaction_id: `tx-${ts}` }] }),
      };
    }
    if (url.includes("/contracts/results/")) {
      const txId = url.split("/contracts/results/")[1];
      const ts = txId.replace(/^tx-/, "");
      const reg = setup.registrations[ts];
      return {
        ok: true,
        json: async () => ({
          function_parameters: reg
            ? encodeRegisterCall(reg.username, reg.ownerType)
            : "0x",
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("GET /api/explore/pages", () => {
  it("includes pages whose registration is buried under many newer PageUpdated events", async () => {
    // Newest-first: 12 re-publish events from a busy user, then 3 registrations
    // (the old code's slice(0,10) would have dropped the oldest registration).
    const logs = [
      ...Array.from({ length: 12 }, (_, i) =>
        log(`179000000${i}.000000000`, PAGEUPDATED_TOPIC),
      ),
      log("1789000003.000000000", PAGEREGISTERED_TOPIC),
      log("1789000002.000000000", PAGEREGISTERED_TOPIC),
      log("1789000001.000000000", PAGEREGISTERED_TOPIC),
    ];
    mockMirrorNode({
      registrations: {
        "1789000003.000000000": { username: "new-user", ownerType: 0 },
        "1789000002.000000000": { username: "mid-user", ownerType: 0 },
        "1789000001.000000000": { username: "old-user", ownerType: 0 },
      },
      logPages: [{ logs }],
    });

    const res = await GET(mockReq("new"));
    const body = await res.json();
    const usernames = body.pages.map((p: { username: string }) => p.username);
    expect(usernames).toContain("old-user");
    expect(usernames).toContain("mid-user");
    expect(usernames).toContain("new-user");
    // featured founder + 3 real pages
    expect(body.count).toBe(4);
  });

  it("dedupes the featured founder against their on-chain registration", async () => {
    const logs = [log("1789000001.000000000", PAGEREGISTERED_TOPIC)];
    mockMirrorNode({
      registrations: { "1789000001.000000000": { username: "user-10424063", ownerType: 0 } },
      logPages: [{ logs }],
    });

    const res = await GET(mockReq("new"));
    const body = await res.json();
    const usernames = body.pages.map((p: { username: string }) => p.username);
    expect(usernames.filter((u: string) => u === "user-10424063")).toHaveLength(1);
    expect(body.pages[0]).toMatchObject({ username: "user-10424063", featured: true });
    expect(body.count).toBe(1);
  });

  it("follows mirror-node pagination to collect every registration", async () => {
    const page1 = [log("1789000002.000000000", PAGEREGISTERED_TOPIC)];
    const page2 = [log("1789000001.000000000", PAGEREGISTERED_TOPIC)];
    mockMirrorNode({
      registrations: {
        "1789000002.000000000": { username: "page-one", ownerType: 0 },
        "1789000001.000000000": { username: "page-two", ownerType: 1 },
      },
      logPages: [{ logs: page1, next: "/api/v1/contracts/0.0.10854058/results/logs?order=desc&limit=100&page=2" }, { logs: page2 }],
    });

    const res = await GET(mockReq("new"));
    const body = await res.json();
    const usernames = body.pages.map((p: { username: string }) => p.username);
    expect(usernames).toContain("page-one");
    expect(usernames).toContain("page-two");
  });

  it("ignores logs whose username cannot be decoded", async () => {
    const logs = [
      log("1789000002.000000000", PAGEREGISTERED_TOPIC),
      log("1789000001.000000000", PAGEREGISTERED_TOPIC), // no registration entry -> decode fails
    ];
    mockMirrorNode({
      registrations: { "1789000002.000000000": { username: "good-user", ownerType: 0 } },
      logPages: [{ logs }],
    });

    const res = await GET(mockReq("new"));
    const body = await res.json();
    const usernames = body.pages.map((p: { username: string }) => p.username);
    expect(usernames).toContain("good-user");
    expect(body.count).toBe(2); // featured + good-user
  });

  it("fails soft to the featured fallback when the mirror node is down", async () => {
    mockMirrorNode({ registrations: {}, logPages: [], failLogs: true });

    const res = await GET(mockReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pages).toHaveLength(1);
    expect(body.pages[0].username).toBe("user-10424063");
    expect(body.count).toBe(1);
  });

  it("defaults to trending and keeps newest-first order when all signals are zero", async () => {
    const logs = [
      log("1789000002.000000000", PAGEREGISTERED_TOPIC),
      log("1789000001.000000000", PAGEREGISTERED_TOPIC),
    ];
    mockMirrorNode({
      registrations: {
        "1789000002.000000000": { username: "newer-user", ownerType: 0 },
        "1789000001.000000000": { username: "older-user", ownerType: 1 },
      },
      logPages: [{ logs }],
    });

    // No sort param → trending. In tests the KV store is in-memory and the
    // stats blob is unavailable, so every signal is 0 and the stable sort
    // keeps the newest-first input order.
    const res = await GET(mockReq());
    const body = await res.json();
    expect(body.sort).toBe("trending");
    const usernames = body.pages.map((p: { username: string }) => p.username);
    expect(usernames).toEqual(["user-10424063", "newer-user", "older-user"]);
  });

  it("echoes sort=new and returns newest-first", async () => {
    const logs = [
      log("1789000002.000000000", PAGEREGISTERED_TOPIC),
      log("1789000001.000000000", PAGEREGISTERED_TOPIC),
    ];
    mockMirrorNode({
      registrations: {
        "1789000002.000000000": { username: "newer-user", ownerType: 0 },
        "1789000001.000000000": { username: "older-user", ownerType: 1 },
      },
      logPages: [{ logs }],
    });

    const res = await GET(mockReq("new"));
    const body = await res.json();
    expect(body.sort).toBe("new");
    const usernames = body.pages.map((p: { username: string }) => p.username);
    expect(usernames).toEqual(["user-10424063", "newer-user", "older-user"]);
  });

  it("includes the on-chain owner type so Explore can mark agent pages", async () => {
    const logs = [
      log("1789000002.000000000", PAGEREGISTERED_TOPIC),
      log("1789000001.000000000", PAGEREGISTERED_TOPIC),
    ];
    mockMirrorNode({
      registrations: {
        "1789000002.000000000": { username: "human-user", ownerType: 0 },
        "1789000001.000000000": { username: "agent-user", ownerType: 1 },
      },
      logPages: [{ logs }],
    });

    const res = await GET(mockReq("new"));
    const body = await res.json();
    const byName = new Map(
      body.pages.map((p: { username: string; ownerType: string }) => [
        p.username,
        p.ownerType,
      ]),
    );
    expect(byName.get("human-user")).toBe("human");
    expect(byName.get("agent-user")).toBe("agent");
    // Featured founder is a known human page.
    expect(byName.get("user-10424063")).toBe("human");
  });
});
