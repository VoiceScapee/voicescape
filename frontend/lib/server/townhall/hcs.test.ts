/** HCS port tests — envelope validation + in-memory client. No network. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryHcsClient, RealHcsClient, isValidEnvelope } from "./hcs";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isValidEnvelope", () => {
  it("accepts a valid envelope", () => {
    expect(
      isValidEnvelope({ v: 1, kind: "post", ts: "2026-09-10T00:00:00Z", author: "alice" }),
    ).toBe(true);
  });

  it("rejects wrong versions and malformed payloads", () => {
    expect(isValidEnvelope({ v: 2, kind: "post", ts: "x", author: "a" })).toBe(false);
    expect(isValidEnvelope({ kind: "post", author: "a" })).toBe(false);
    expect(isValidEnvelope(null)).toBe(false);
    expect(isValidEnvelope("not json")).toBe(false);
    expect(isValidEnvelope(42)).toBe(false);
  });
});

describe("RealHcsClient (ts backfill)", () => {
  it("re-reads a ts-less message, backfilling ts from the consensus timestamp", async () => {
    // Lev's seq 20/21 (Clearance second pass, 2026-11-28, finding F):
    // valid MCP writes with no `ts` that the indexer dropped for months.
    const payload = { v: 1, kind: "post", author: "clearance-run-agent", board: "general", body: "hello" };
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    vi.stubGlobal(
      "fetch",
      async (url: unknown) =>
        new Response(
          JSON.stringify(
            String(url).includes("/topics/0.0.10854065/messages")
              ? {
                  messages: [
                    {
                      consensus_timestamp: "1789900000.123456789",
                      sequence_number: 21,
                      message: b64,
                    },
                  ],
                }
              : { messages: [] },
          ),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const hcs = new RealHcsClient();
    const page = await hcs.query("0.0.10854065");
    expect(page).toHaveLength(1);
    expect(page[0].seq).toBe(21);
    const contents = page[0].contents as unknown as Record<string, unknown>;
    expect(contents.author).toBe("clearance-run-agent");
    expect(contents.ts).toBe("1789900000.123456789");
  });

  it("still reads a message that carries its own ts", async () => {
    const payload = {
      v: 1,
      kind: "post",
      author: "forge",
      ts: "2026-09-10T00:00:00.000Z",
      board: "general",
      body: "hello",
    };
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            messages: [{ consensus_timestamp: "1789900000.123456789", sequence_number: 22, message: b64 }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const hcs = new RealHcsClient();
    const page = await hcs.query("0.0.10854065");
    expect(page).toHaveLength(1);
    expect((page[0].contents as unknown as Record<string, unknown>).ts).toBe("2026-09-10T00:00:00.000Z");
  });
});

describe("MemoryHcsClient", () => {
  it("assigns incrementing sequence numbers and queries in order", async () => {
    const hcs = new MemoryHcsClient();
    const s1 = hcs.seed("0.0.1", { v: 1, kind: "chat", ts: "2026-09-10T00:00:00Z", author: "a" });
    const s2 = hcs.seed("0.0.1", { v: 1, kind: "chat", ts: "2026-09-10T00:00:00Z", author: "a" });
    const s3 = hcs.seed("0.0.2", { v: 1, kind: "post", ts: "2026-09-10T00:00:00Z", author: "a" });
    expect([s1, s2, s3]).toEqual([1, 2, 1]); // per-topic sequences
    const page = await hcs.query("0.0.1");
    expect(page.map((m) => m.seq)).toEqual([1, 2]);
  });

  it("query respects afterSeq cursor", async () => {
    const hcs = new MemoryHcsClient();
    hcs.seed("0.0.1", { v: 1, kind: "chat", ts: "2026-09-10T00:00:00Z", author: "a" });
    hcs.seed("0.0.1", { v: 1, kind: "chat", ts: "2026-09-10T00:00:00Z", author: "a" });
    const page = await hcs.query("0.0.1", { afterSeq: 1 });
    expect(page.map((m) => m.seq)).toEqual([2]);
  });

  it("queryAll returns everything", async () => {
    const hcs = new MemoryHcsClient();
    for (let i = 0; i < 5; i++) hcs.seed("0.0.1", { v: 1, kind: "chat", ts: "2026-09-10T00:00:00Z", author: "a" });
    const all = await hcs.queryAll("0.0.1");
    expect(all).toHaveLength(5);
  });

  it("verifyTx accepts well-formed txIds for the expected payer", async () => {
    const hcs = new MemoryHcsClient();
    const result = await hcs.verifyTx("0.0.123@1234567890.123456789", "0.0.1", "0.0.123");
    expect(result).not.toBeNull();
    expect(result?.topicId).toBe("0.0.1");
    expect(result?.payer).toBe("0.0.123");
  });

  it("verifyTx rejects malformed txIds", async () => {
    const hcs = new MemoryHcsClient();
    const result = await hcs.verifyTx("not-a-txid", "0.0.1", "0.0.123");
    expect(result).toBeNull();
  });
});
