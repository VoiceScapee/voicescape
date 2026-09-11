/**
 * Tests for the Voicescape Agent Executor (lib/server/agents/executor.ts).
 *
 * Covers: instruction parsing (tip/post/buy), safety limits (max HBAR,
 * content filter), and unsigned transaction building (RETURN_BYTES —
 * valid structure, no signatures).
 */
import { describe, expect, it } from "vitest";
import {
  buildBuyTransaction,
  buildPostTransaction,
  buildTipTransaction,
  MAX_HBAR_PER_OP,
  parseInstruction,
  type BuildContext,
} from "./executor";

const TEST_CTX: BuildContext = {
  payerAccountId: "0.0.12345",
  network: "testnet",
};

describe("parseInstruction — tips", () => {
  it("parses 'tip 5 HBAR to @brandon'", () => {
    const r = parseInstruction("tip 5 HBAR to @brandon");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.op).toEqual({ kind: "tip", amountHbar: 5, targetUsername: "brandon" });
    }
  });

  it("parses 'send 10 hbar to @alice' (send variant)", () => {
    const r = parseInstruction("send 10 hbar to @alice");
    expect(r.ok).toBe(true);
    if (r.ok && r.op.kind === "tip") {
      expect(r.op.amountHbar).toBe(10);
      expect(r.op.targetUsername).toBe("alice");
    }
  });

  it("parses 'tip @bob 2.5' (username-first variant)", () => {
    const r = parseInstruction("tip @bob 2.5");
    expect(r.ok).toBe(true);
    if (r.ok && r.op.kind === "tip") {
      expect(r.op.amountHbar).toBe(2.5);
    }
  });

  it("rejects tips over the max HBAR limit", () => {
    const r = parseInstruction(`tip ${MAX_HBAR_PER_OP + 1} HBAR to @brandon`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exceeds/i);
  });

  it("rejects zero/negative tip amounts", () => {
    expect(parseInstruction("tip 0 HBAR to @brandon").ok).toBe(false);
  });
});

describe("parseInstruction — posts", () => {
  it("parses \"post 'hello' to the forum\"", () => {
    const r = parseInstruction("post 'hello world' to the forum");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.op).toEqual({ kind: "post", message: "hello world", destination: "forum" });
    }
  });

  it("parses 'post to chat: hello' (colon variant)", () => {
    const r = parseInstruction("post to chat: hello there");
    expect(r.ok).toBe(true);
    if (r.ok && r.op.kind === "post") {
      expect(r.op.destination).toBe("chat");
      expect(r.op.message).toBe("hello there");
    }
  });

  it("blocks messages that fail the content filter", () => {
    // The filter blocks high-signal illegal content; use a threat pattern.
    const r = parseInstruction("post 'i will kill you tomorrow' to the forum");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/blocked/i);
  });
});

describe("parseInstruction — buys", () => {
  it("parses 'buy listing abc from 0x... for 5 HBAR'", () => {
    const seller = "0x" + "ab".repeat(20);
    const r = parseInstruction(`buy listing my-item from ${seller} for 5 HBAR`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.op).toEqual({
        kind: "buy",
        listingRef: "my-item",
        sellerAddress: seller.toLowerCase(),
        priceHbar: 5,
      });
    }
  });

  it("rejects buys over the max HBAR limit", () => {
    const seller = "0x" + "ab".repeat(20);
    const r = parseInstruction(`buy listing x from ${seller} for ${MAX_HBAR_PER_OP + 50} HBAR`);
    expect(r.ok).toBe(false);
  });

  it("rejects unparseable instructions with a helpful error", () => {
    const r = parseInstruction("do something magical");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/tip 5 HBAR/);
  });

  it("rejects empty instructions", () => {
    expect(parseInstruction("").ok).toBe(false);
    expect(parseInstruction("   ").ok).toBe(false);
  });
});

describe("buildTipTransaction", () => {
  const TIPS = "0x" + "ab".repeat(20);

  it("routes tips through the Tips contract (98/2 split, not a raw transfer)", () => {
    const built = buildTipTransaction(
      { kind: "tip", amountHbar: 5, targetUsername: "brandon" },
      { ...TEST_CTX, tipsContractAddress: TIPS },
    );
    expect(built.description).toMatch(/tip 5 hbar/i);
    expect(built.description).toMatch(/98%/);
    expect(built.txType).toBe("ContractExecuteTransaction");
    expect(built.transactionId).toMatch(/0\.0\.12345@/);
    // Base64-encoded bytes, non-empty.
    expect(built.unsignedTxBytes.length).toBeGreaterThan(100);
    expect(() => Buffer.from(built.unsignedTxBytes, "base64")).not.toThrow();
  });

  it("throws without a tips contract address", () => {
    expect(() =>
      buildTipTransaction({ kind: "tip", amountHbar: 5, targetUsername: "x" }, TEST_CTX),
    ).toThrow(/tips contract/i);
  });

  it("throws on a malformed tips contract address", () => {
    expect(() =>
      buildTipTransaction(
        { kind: "tip", amountHbar: 5, targetUsername: "x" },
        { ...TEST_CTX, tipsContractAddress: "not-an-address" },
      ),
    ).toThrow(/invalid/);
  });
});

describe("buildPostTransaction", () => {
  it("produces valid unsigned HCS tx bytes", () => {
    const built = buildPostTransaction(
      { kind: "post", message: "hello world", destination: "forum" },
      { ...TEST_CTX, topicId: "0.0.11111" },
    );
    expect(built.description).toMatch(/forum/i);
    expect(built.txType).toBe("TopicMessageSubmitTransaction");
    expect(built.unsignedTxBytes.length).toBeGreaterThan(100);
  });

  it("throws without a topic id", () => {
    expect(() =>
      buildPostTransaction({ kind: "post", message: "hi", destination: "chat" }, TEST_CTX),
    ).toThrow(/topic/i);
  });
});

describe("buildBuyTransaction", () => {
  const seller = "0x" + "cd".repeat(20);
  const tips = "0x" + "ef".repeat(20);

  it("produces valid unsigned contract tx bytes", () => {
    const built = buildBuyTransaction(
      { kind: "buy", listingRef: "item-1", sellerAddress: seller, priceHbar: 5 },
      { ...TEST_CTX, tipsContractAddress: tips },
    );
    expect(built.description).toMatch(/98%/);
    expect(built.txType).toBe("ContractExecuteTransaction");
    expect(built.unsignedTxBytes.length).toBeGreaterThan(100);
  });

  it("rejects prices over the limit (defense in depth)", () => {
    expect(() =>
      buildBuyTransaction(
        { kind: "buy", listingRef: "x", sellerAddress: seller, priceHbar: MAX_HBAR_PER_OP + 1 },
        { ...TEST_CTX, tipsContractAddress: tips },
      ),
    ).toThrow(/exceeds/i);
  });

  it("throws without a contract address", () => {
    expect(() =>
      buildBuyTransaction(
        { kind: "buy", listingRef: "x", sellerAddress: seller, priceHbar: 1 },
        TEST_CTX,
      ),
    ).toThrow(/contract/i);
  });
});
