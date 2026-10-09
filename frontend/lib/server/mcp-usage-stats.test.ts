/**
 * Tests for mcp-usage-stats: anonymous aggregate counters.
 * Fake in-memory KvStore — no network, no real store.
 */
import { describe, it, expect } from "vitest";
import type { KvStore } from "./store";
import {
  recordMcpToolCall,
  getMcpUsageStats,
  getMcpToolCounts,
  KNOWN_MCP_TOOLS,
} from "./mcp-usage-stats";

function fakeStore() {
  const map = new Map<string, string>();
  const ttls = new Map<string, number>();
  const store: KvStore = {
    async get(k: string) { return map.get(k) ?? null; },
    async set(k: string, v: string, ttlMs: number) { map.set(k, v); ttls.set(k, ttlMs); },
    async del(k: string) { map.delete(k); },
    async incr(k: string, ttlMs: number) {
      const n = (parseInt(map.get(k) ?? "0", 10) || 0) + 1;
      map.set(k, String(n));
      if (!ttls.has(k)) ttls.set(k, ttlMs);
      return n;
    },
    async setNx(k: string, v: string, ttlMs: number) {
      if (map.has(k)) return false;
      map.set(k, v); ttls.set(k, ttlMs);
      return true;
    },
    async clearPrefix(prefix: string) {
      for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k);
    },
  };
  return { store, map, ttls };
}

const DAY = new Date().toISOString().slice(0, 10);

describe("mcp-usage-stats", () => {
  it("counts total, per-tool, and per-day on each call", async () => {
    const { store, map, ttls } = fakeStore();
    await recordMcpToolCall("verify_tip", { store });
    await recordMcpToolCall("verify_tip", { store });
    await recordMcpToolCall("treasury_stats", { store });

    expect(map.get("mcp:stats:calls:total")).toBe("3");
    expect(map.get("mcp:stats:calls:tool:verify_tip")).toBe("2");
    expect(map.get("mcp:stats:calls:tool:treasury_stats")).toBe("1");
    expect(map.get(`mcp:stats:calls:day:${DAY}`)).toBe("3");
    // 30-day TTL on every key.
    expect(ttls.get("mcp:stats:calls:total")).toBe(30 * 24 * 3_600_000);
  });

  it("reads back aggregates with zeros for missing keys", async () => {
    const { store } = fakeStore();
    await recordMcpToolCall("lookup_blockpage", { store });
    const s = await getMcpUsageStats({ store });
    expect(s.total).toBe(1);
    expect(s.byDay[DAY]).toBe(1);

    const counts = await getMcpToolCounts(["lookup_blockpage", "verify_tip"], { store });
    expect(counts).toEqual({ lookup_blockpage: 1, verify_tip: 0 });
  });

  it("sanitizes tool names and never throws on store failure", async () => {
    const { store, map } = fakeStore();
    await recordMcpToolCall("weird;name\x00", { store });
    expect(map.get("mcp:stats:calls:tool:weirdname")).toBe("1");

    const broken: KvStore = {
      ...store,
      incr: async () => { throw new Error("kv down"); },
      get: async () => { throw new Error("kv down"); },
    };
    await recordMcpToolCall("verify_tip", { store: broken }); // no throw
    const s = await getMcpUsageStats({ store: broken });
    expect(s.total).toBe(0);
    expect(await getMcpToolCounts(["x"], { store: broken })).toEqual({ x: 0 });
  });

  // NOTE: 30s timeout — importing mcp-tool-registry takes ~15s in this
  // environment (pre-existing on master, verified 2026-10-09; not branch-caused).
  // The 5s default flakes here. Assertion itself is untouched.
  it("KNOWN_MCP_TOOLS matches the tools the registry actually registers", async () => {
    const { registerTools } = await import("./mcp-tool-registry");
    const names: string[] = [];
    const stub = {
      registerTool: (name: string) => {
        names.push(name);
      },
      registerResource: () => {},
    };
    registerTools(stub as never);
    expect([...names].sort()).toEqual([...KNOWN_MCP_TOOLS].sort());
  }, 30000);

  it("getMcpUsageStats reports per-tool counts for tools with calls", async () => {
    const { store } = fakeStore();
    await recordMcpToolCall("verify_tip", { store });
    await recordMcpToolCall("verify_tip", { store });
    await recordMcpToolCall("lookup_blockpage", { store });
    const s = await getMcpUsageStats({ store });
    expect(s.byTool).toEqual({ verify_tip: 2, lookup_blockpage: 1 });
  });
});
