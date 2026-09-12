/** HCS cache tests — storage semantics + read-through wrapper. No network. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  CachedHcsClient,
  MemoryHcsClient,
  type HcsPort,
  type QueryOpts,
} from "./hcs";
import type { StoredMessage, TownhallMessage } from "./types";
import {
  createHcsCache,
  createMemoryHcsCache,
  type HcsCache,
} from "./hcs-cache";
import { createMemoryKvStore } from "../store";

function makeMsg(seq: number, topic: string): StoredMessage<TownhallMessage> {
  return {
    seq,
    topic,
    consensusTimestamp: "2026-09-10T00:00:00Z",
    contents: {
      v: 1 as const,
      kind: "chat",
      author: "alice",
      ts: "2026-09-10T00:00:00Z",
      room: "lobby",
      body: `msg ${seq}`,
    },
  };
}

/** Inner port with call counters, over the in-memory client. */
class CountingPort implements HcsPort {
  queryCalls = 0;
  queryAllCalls = 0;
  verifyCalls = 0;
  private mem = new MemoryHcsClient();

  seed(topicId: string): void {
    this.mem.seed(topicId, {
      v: 1,
      kind: "chat",
      author: "alice",
      ts: "2026-09-10T00:00:00Z",
      room: "lobby",
      body: "hello",
    });
  }

  async verifyTx(txId: string, expectedTopicId: string, expectedPayer: string) {
    this.verifyCalls++;
    return this.mem.verifyTx(txId, expectedTopicId, expectedPayer);
  }

  async query<T = TownhallMessage>(topicId: string, opts: QueryOpts = {}): Promise<StoredMessage<T>[]> {
    this.queryCalls++;
    return this.mem.query<T>(topicId, opts);
  }

  async queryAll<T = TownhallMessage>(topicId: string, max = 2000): Promise<StoredMessage<T>[]> {
    this.queryAllCalls++;
    return this.mem.queryAll<T>(topicId, max);
  }
}

describe("HcsCache (createMemoryHcsCache)", () => {
  let cache: HcsCache;
  beforeEach(() => {
    cache = createMemoryHcsCache();
  });

  it("set then get returns the value", async () => {
    await cache.set("topic-a:0:100", [makeMsg(1, "topic-a")], 15);
    const got = await cache.get<StoredMessage[]>("topic-a:0:100");
    expect(got).not.toBeNull();
    expect(got![0].seq).toBe(1);
    expect(got![0].contents.kind).toBe("chat");
  });

  it("get on a missing key returns null", async () => {
    expect(await cache.get("nope:0:100")).toBeNull();
  });

  it("invalidateTopic clears only that topic's keys", async () => {
    await cache.set("0.0.1:0:100", ["a"], 60);
    await cache.set("0.0.1:all:2000", ["b"], 60);
    await cache.set("0.0.2:0:100", ["c"], 60);
    await cache.invalidateTopic("0.0.1");
    expect(await cache.get("0.0.1:0:100")).toBeNull();
    expect(await cache.get("0.0.1:all:2000")).toBeNull();
    expect(await cache.get<string[]>("0.0.2:0:100")).toEqual(["c"]);
  });

  it("clearAll drops the whole namespace", async () => {
    await cache.set("0.0.1:0:100", ["a"], 60);
    await cache.clearAll();
    expect(await cache.get("0.0.1:0:100")).toBeNull();
  });

  it("set with non-positive TTL throws", async () => {
    await expect(cache.set("k", 1, 0)).rejects.toThrow();
  });

  it("a cache over a failing backend fails open on reads and writes", async () => {
    const boom = {
      async get(): Promise<string | null> {
        throw new Error("redis down");
      },
      async set(): Promise<void> {
        throw new Error("redis down");
      },
      async incr(): Promise<number> {
        throw new Error("redis down");
      },
      async setNx(): Promise<boolean> {
        throw new Error("redis down");
      },
      async del(): Promise<void> {
        throw new Error("redis down");
      },
      async clearPrefix(): Promise<void> {
        throw new Error("redis down");
      },
    };
    const c = createHcsCache(boom);
    expect(await c.get("k")).toBeNull();
    await c.set("k", { x: 1 }, 15); // must not throw
    await c.invalidateTopic("0.0.1"); // must not throw
  });

  it("TTL expiry drops the entry (memory backend)", async () => {
    await cache.set("expiring", { x: 1 }, 1);
    expect(await cache.get("expiring")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1150));
    expect(await cache.get("expiring")).toBeNull();
  });
});

describe("CachedHcsClient", () => {
  it("cache hit returns cached data without calling the inner port again", async () => {
    const inner = new CountingPort();
    inner.seed("0.0.1");
    const cache = createHcsCache(createMemoryKvStore());
    const cached = new CachedHcsClient(inner, cache);
    const first = await cached.query("0.0.1");
    const second = await cached.query("0.0.1");
    expect(inner.queryCalls).toBe(1);
    expect(second).toEqual(first);
  });

  it("different afterSeq values are cached separately", async () => {
    const inner = new CountingPort();
    inner.seed("0.0.1");
    const cached = new CachedHcsClient(inner, createMemoryHcsCache());
    await cached.query("0.0.1", { afterSeq: 0 });
    await cached.query("0.0.1", { afterSeq: 1 });
    expect(inner.queryCalls).toBe(2);
  });

  it("verifyTx is not cached (always fresh)", async () => {
    const inner = new CountingPort();
    const cached = new CachedHcsClient(inner, createMemoryHcsCache());
    await cached.verifyTx("0.0.123@1234567890.123456789", "0.0.1", "0.0.123");
    await cached.verifyTx("0.0.123@1234567890.123456789", "0.0.1", "0.0.123");
    // Each verifyTx goes to the inner port (no caching for verification)
    expect(inner.verifyCalls).toBe(2);
  });

  it("expired TTL causes a refetch", async () => {
    const inner = new CountingPort();
    inner.seed("0.0.1");
    const cached = new CachedHcsClient(inner, createMemoryHcsCache(), { queryTtlSeconds: 1 });
    await cached.query("0.0.1");
    expect(inner.queryCalls).toBe(1);
    await new Promise((r) => setTimeout(r, 1150));
    await cached.query("0.0.1");
    expect(inner.queryCalls).toBe(2);
  }, 10000);

  it("queryAll is cached with its own TTL and key", async () => {
    const inner = new CountingPort();
    inner.seed("0.0.1");
    const cached = new CachedHcsClient(inner, createMemoryHcsCache());
    await cached.queryAll("0.0.1");
    await cached.queryAll("0.0.1");
    expect(inner.queryAllCalls).toBe(1);
    // query() and queryAll() do not share cache keys.
    await cached.query("0.0.1");
    expect(inner.queryCalls).toBe(1);
  });

  it("logs hits and misses via console.debug", async () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const inner = new CountingPort();
      inner.seed("0.0.1");
      const cached = new CachedHcsClient(inner, createMemoryHcsCache());
      await cached.query("0.0.1"); // miss
      await cached.query("0.0.1"); // hit
      const logs = spy.mock.calls.map((c) => String(c[0]));
      expect(logs.some((l) => l.includes("query miss"))).toBe(true);
      expect(logs.some((l) => l.includes("query hit"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
