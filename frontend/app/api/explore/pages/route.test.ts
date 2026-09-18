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

import { GET } from "./route";
import { PAGEREGISTERED_TOPIC, PAGEUPDATED_TOPIC } from "@/lib/registry-topics";

const realFetch = globalThis.fetch;

/** Minimal ABI encoding of registerPage(username, ...) — decodeUsername only reads the first string arg. */
function encodeRegisterCall(username: string): string {
  const strHex = Buffer.from(username, "utf8").toString("hex");
  const offset = (32).toString(16).padStart(64, "0");
  const len = username.length.toString(16).padStart(64, "0");
  const padded = strHex.padEnd(Math.ceil(strHex.length / 64) * 64, "0");
  return "0xdeadbeef" + offset + len + padded;
}

function log(timestamp: string, topic: string, owner = "fc1177680ecf347f06cf3c086fa58ca2713fb462") {
  return {
    timestamp,
    topics: [topic, "0x" + "ab".repeat(32), "0x" + "00".repeat(12) + owner],
  };
}

interface MockSetup {
  /** timestamp -> username for registration logs */
  registrations: Record<string, string>;
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
      const username = setup.registrations[ts];
      return {
        ok: true,
        json: async () => ({
          function_parameters: username ? encodeRegisterCall(username) : "0x",
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
        "1789000003.000000000": "new-user",
        "1789000002.000000000": "mid-user",
        "1789000001.000000000": "old-user",
      },
      logPages: [{ logs }],
    });

    const res = await GET();
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
      registrations: { "1789000001.000000000": "user-10424063" },
      logPages: [{ logs }],
    });

    const res = await GET();
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
        "1789000002.000000000": "page-one",
        "1789000001.000000000": "page-two",
      },
      logPages: [{ logs: page1, next: "/api/v1/contracts/0.0.10854058/results/logs?order=desc&limit=100&page=2" }, { logs: page2 }],
    });

    const res = await GET();
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
      registrations: { "1789000002.000000000": "good-user" },
      logPages: [{ logs }],
    });

    const res = await GET();
    const body = await res.json();
    const usernames = body.pages.map((p: { username: string }) => p.username);
    expect(usernames).toContain("good-user");
    expect(body.count).toBe(2); // featured + good-user
  });

  it("fails soft to the featured fallback when the mirror node is down", async () => {
    mockMirrorNode({ registrations: {}, logPages: [], failLogs: true });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pages).toHaveLength(1);
    expect(body.pages[0].username).toBe("user-10424063");
    expect(body.count).toBe(1);
  });
});
