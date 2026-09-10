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
    const s1 = await hcs.submit("0.0.1", { v: 1, kind: "chat" });
    const s2 = await hcs.submit("0.0.1", { v: 1, kind: "chat" });
    const s3 = await hcs.submit("0.0.2", { v: 1, kind: "post" });
    expect([s1, s2, s3]).toEqual([1, 2, 1]); // per-topic sequences
    const page = await hcs.query("0.0.1");
    expect(page.map((m) => m.seq)).toEqual([1, 2]);
  });

  it("query respects afterSeq cursor", async () => {
    const hcs = new MemoryHcsClient();
    await hcs.submit("0.0.1", { v: 1, kind: "chat" });
    await hcs.submit("0.0.1", { v: 1, kind: "chat" });
    const page = await hcs.query("0.0.1", { afterSeq: 1 });
    expect(page.map((m) => m.seq)).toEqual([2]);
  });

  it("queryAll returns everything", async () => {
    const hcs = new MemoryHcsClient();
    for (let i = 0; i < 5; i++) await hcs.submit("0.0.1", { v: 1, kind: "chat" });
    const all = await hcs.queryAll("0.0.1");
    expect(all).toHaveLength(5);
  });
});
