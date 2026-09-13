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

describe("verifyHcsTransaction production regression: wallet txId form + payer", () => {
  // Regression: wallets/SDK hand us 0.0.x@seconds.nanos, but the mirror
  // node only answers the dash form. Passing the @ form through returned
  // nothing, which silently broke every user-signed Town Hall write.
  it("queries the mirror with the dash form when given a wallet @-form txId", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        seen.push(String(url));
        const u = String(url);
        const body = u.includes("/transactions/") ? txRecord() : messageRecord(b64("{}"));
        return { ok: true, json: async () => body } as Response;
      }),
    );
    await verifyHcsTransaction(TX_ID, TOPIC, PAYER);
    const txUrl = seen.find((u) => u.includes("/transactions/")) ?? "";
    expect(txUrl).toContain("0.0.123-1234567890-123456789");
    expect(txUrl).not.toContain("@");
  });

  // Regression: the mirror's transactions list endpoint omits
  // payer_account_id. Verification must fall back to the payer embedded
  // in the transaction ID instead of rejecting every real transaction.
  it("accepts a real mirror record with no payer_account_id via the txId payer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        const body = u.includes("/transactions/")
          ? { transactions: [{ ...txRecord().transactions[0], payer_account_id: undefined }] }
          : messageRecord(b64("{}"));
        return { ok: true, json: async () => body } as Response;
      }),
    );
    const res = await verifyHcsTransaction(TX_ID, TOPIC, PAYER);
    expect(res).not.toBeNull();
    expect(res!.payer).toBe(PAYER);
  });

  it("still rejects when the txId payer differs from the session payer", async () => {
    stubMirror(b64("{}"));
    const res = await verifyHcsTransaction(TX_ID, TOPIC, "0.0.999999");
    expect(res).toBeNull();
  });
});
