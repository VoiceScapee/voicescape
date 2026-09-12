import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyHcsTransaction } from "./hcs-verify";

const TX_ID = "0.0.123@1234567890.123456789";
const TOPIC = "0.0.999";
const PAYER = "0.0.123";

function txRecord() {
  return {
    transactions: [
      {
        transaction_id: TX_ID,
        name: "CONSENSUSSUBMITMESSAGE",
        result: "SUCCESS",
        entity_id: TOPIC,
        payer_account_id: PAYER,
        consensus_timestamp: "1234567890.123456789",
      },
    ],
  };
}

function messageRecord(messageB64: string, chunkInfo?: { number: number; total: number }) {
  return {
    messages: [
      {
        consensus_timestamp: "1234567890.123456789",
        message: messageB64,
        sequence_number: 42,
        ...(chunkInfo ? { chunk_info: chunkInfo } : {}),
      },
    ],
  };
}

function stubMirror(messageB64: string, chunkInfo?: { number: number; total: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      const body = u.includes("/transactions/") ? txRecord() : messageRecord(messageB64, chunkInfo);
      return { ok: true, json: async () => body } as Response;
    }),
  );
}

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyHcsTransaction message-size guards", () => {
  it("accepts a small single-chunk message", async () => {
    stubMirror(b64(JSON.stringify({ v: 1 })));
    const res = await verifyHcsTransaction(TX_ID, TOPIC, PAYER);
    expect(res).not.toBeNull();
    expect(res!.sequenceNumber).toBe(42);
  });

  it("rejects a chunked message (SDK auto-chunked, never reassembled)", async () => {
    stubMirror(b64(JSON.stringify({ v: 1 })), { number: 1, total: 2 });
    const res = await verifyHcsTransaction(TX_ID, TOPIC, PAYER);
    expect(res).toBeNull();
  });

  it("rejects an oversized single-chunk message", async () => {
    stubMirror(b64("x".repeat(2000)));
    const res = await verifyHcsTransaction(TX_ID, TOPIC, PAYER);
    expect(res).toBeNull();
  });
});
