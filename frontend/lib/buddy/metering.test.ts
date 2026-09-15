/**
 * Buddy metering adversarial tests (dapp port).
 *
 * The guarantees under test — ported from the ops runtime's audit:
 *  1. 10 concurrent credit-claims on one payment → exactly 1 winner.
 *  2. 5 concurrent build spends → exactly 1 winner.
 *  3. Chat/build first-use race → the payment kind is assigned exactly
 *     once (chat XOR build), never both.
 *  4. 60 takes on a 50-credit payment → exactly 50 succeed, left hits 0.
 *  5. Invalid inputs (empty payment id, bad TTL) throw rather than
 *     silently succeeding.
 *  6. Replay of a spent payment is denied.
 *  7. Free tier: 5 free, the 6th is denied (anon, no payer).
 *  8. Paid flow: credit → 50 paid messages → exhausted → denied.
 *  9. Mirror-node discovery: finds fresh 5-HBAR forge tips, skips
 *     consumed and under-amount logs (stubbed fetch, no network).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryKvStore } from "../server/store";
import {
  CHAT_MESSAGES_PER_PAYMENT,
  FREE_MESSAGES,
  checkBuildAccess,
  checkChatAccess,
  chatMessagesLeft,
  claimPaymentCredit,
  claimPaymentSpend,
  consumeBuild,
  creditPayment,
  discoverPayments,
  noteChatMessage,
  paywallMessage,
  sanitizeSessionId,
  takeChatUnit,
} from "./metering";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("credit claims (buddy:payclaim:)", () => {
  it("10 concurrent claims on one payment yield exactly 1 winner", async () => {
    const store = createMemoryKvStore();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimPaymentCredit("pay-race-1", store)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a second credit of the same payment is denied (replay)", async () => {
    const store = createMemoryKvStore();
    expect(await creditPayment("sess-replay", "pay-replay-1", store)).toBe(true);
    expect(await creditPayment("sess-replay", "pay-replay-1", store)).toBe(false);
    expect(await claimPaymentCredit("pay-replay-1", store)).toBe(false);
  });

  it("invalid inputs throw rather than silently succeeding", async () => {
    const store = createMemoryKvStore();
    await expect(claimPaymentCredit("", store)).rejects.toThrow();
    await expect(claimPaymentSpend("", store)).rejects.toThrow();
    await expect(takeChatUnit("", store)).rejects.toThrow();
    // Bad TTL-shaped args: the store validates TTLs, so these throw.
    await expect(claimPaymentCredit("pay-x", store, -1)).rejects.toThrow();
    await expect(claimPaymentSpend("pay-x", store, 0)).rejects.toThrow();
    await expect(takeChatUnit("pay-x", store, Number.NaN)).rejects.toThrow();
  });
});

describe("spend claims (buddy:payspend:) — chat XOR build", () => {
  it("5 concurrent build spends yield exactly 1 winner", async () => {
    const store = createMemoryKvStore();
    expect(await creditPayment("sess-build", "pay-build-1", store)).toBe(true);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => consumeBuild("sess-build", store)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("chat/build first-use race assigns the kind exactly once", async () => {
    const store = createMemoryKvStore();
    expect(await creditPayment("sess-race", "pay-race-2", store)).toBe(true);
    const [chatAccess, buildWon] = await Promise.all([
      checkChatAccess("sess-race", undefined, store),
      consumeBuild("sess-race", store),
    ]);
    const chatWon = chatAccess.allowed === true && chatAccess.kind === "paid";
    // Exactly one side won the payment.
    expect(Number(chatWon) + Number(buildWon)).toBe(1);
  });

  it("replay of a spent (build) payment is denied", async () => {
    const store = createMemoryKvStore();
    expect(await creditPayment("sess-spent", "pay-spent-1", store)).toBe(true);
    expect(await consumeBuild("sess-spent", store)).toBe(true);
    // Second spend attempt: denied.
    expect(await consumeBuild("sess-spent", store)).toBe(false);
    expect(await claimPaymentSpend("pay-spent-1", store)).toBe(false);
    // Chat cannot reuse a build-spent payment either.
    const access = await checkChatAccess("sess-spent", undefined, store);
    expect(access.allowed).toBe(false);
    const build = await checkBuildAccess("sess-spent", undefined, store);
    expect(build.allowed).toBe(false);
  });
});

describe("message counter (buddy:payleft:) — count-up", () => {
  it("60 concurrent takes on 50 credits succeed exactly 50 times, left hits 0", async () => {
    const store = createMemoryKvStore();
    const results = await Promise.all(
      Array.from({ length: 60 }, () => takeChatUnit("pay-take-1", store)),
    );
    expect(results.filter(Boolean)).toHaveLength(50);
    expect(await chatMessagesLeft("pay-take-1", store)).toBe(0);
    // Further takes keep failing.
    expect(await takeChatUnit("pay-take-1", store)).toBe(false);
  });

  it("a fresh counter reads full allowance", async () => {
    const store = createMemoryKvStore();
    expect(await chatMessagesLeft("pay-fresh-1", store)).toBe(CHAT_MESSAGES_PER_PAYMENT);
  });
});

describe("free tier", () => {
  it("5 free messages, then denied for an anonymous session", async () => {
    const store = createMemoryKvStore();
    const first = await checkChatAccess("anon", undefined, store);
    expect(first).toEqual({ allowed: true, kind: "free", left: FREE_MESSAGES });
    for (let i = 0; i < FREE_MESSAGES; i++) {
      await noteChatMessage("anon", "free", store);
    }
    const denied = await checkChatAccess("anon", undefined, store);
    expect(denied.allowed).toBe(false);
    expect(paywallMessage(true)).toContain("connect");
  });
});

describe("paid chat flow", () => {
  it("credit → 50 paid messages → exhausted → denied", async () => {
    const store = createMemoryKvStore();
    const sid = "wallet-0xabc";
    expect(await creditPayment(sid, "pay-flow-1", store)).toBe(true);
    const access = await checkChatAccess(sid, undefined, store);
    expect(access).toEqual({ allowed: true, kind: "paid", left: 50 });
    for (let i = 0; i < 50; i++) {
      await noteChatMessage(sid, "paid", store);
    }
    expect(await chatMessagesLeft("pay-flow-1", store)).toBe(0);
    const exhausted = await checkChatAccess(sid, undefined, store);
    expect(exhausted.allowed).toBe(false);
  });
});

describe("sanitizeSessionId", () => {
  it("accepts wallet- and anon-style ids, rejects the rest", () => {
    expect(sanitizeSessionId("wallet-0xabc123")).toBe("wallet-0xabc123");
    expect(sanitizeSessionId("anon")).toBe("anon");
    expect(sanitizeSessionId("buddy:session:x")).toBe("local");
    expect(sanitizeSessionId("../../etc")).toBe("local");
    expect(sanitizeSessionId("")).toBe("local");
  });
});

describe("discoverPayments (stubbed mirror node)", () => {
  // 5 HBAR in wei = 5e18 = 0x4563918244F40000
  const fiveHbar = `0x${(5_000_000_000_000_000_000n).toString(16).padStart(64, "0")}${"0".repeat(64)}`;
  const oneHbar = `0x${(1_000_000_000_000_000_000n).toString(16).padStart(64, "0")}${"0".repeat(64)}`;
  const payer = `0x${"ab".repeat(20)}`;

  function stubLogs(logs: Array<Record<string, unknown>>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/accounts/")) {
          return { ok: true, json: async () => ({ evm_address: payer }) };
        }
        return { ok: true, json: async () => ({ logs }) };
      }),
    );
  }

  it("finds fresh 5-HBAR forge tips, skips consumed and under-amount logs", async () => {
    stubLogs([
      { data: fiveHbar, timestamp: "111", transaction_index: 2 },
      { data: fiveHbar, timestamp: "112", transaction_index: 3 }, // consumed
      { data: oneHbar, timestamp: "113", transaction_index: 4 }, // too small
      { data: "0x1234", timestamp: "114", transaction_index: 5 }, // malformed
    ]);
    const fresh = await discoverPayments(payer, ["112-3"]);
    expect(fresh).toEqual(["111-2"]);
  });

  it("resolves 0.0.x account ids via the accounts endpoint", async () => {
    stubLogs([{ data: fiveHbar, timestamp: "200", transaction_index: 0 }]);
    const fresh = await discoverPayments("0.0.10424063", []);
    expect(fresh).toEqual(["200-0"]);
  });

  it("mirror hiccups return no payments, never throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(discoverPayments(payer, [])).resolves.toEqual([]);
    await expect(discoverPayments("bogus!!", [])).resolves.toEqual([]);
  });
});
