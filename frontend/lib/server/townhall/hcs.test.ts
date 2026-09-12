/** HCS port tests — envelope validation + in-memory client. No network. */
import { describe, expect, it } from "vitest";
import { MemoryHcsClient, isValidEnvelope } from "./hcs";

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
