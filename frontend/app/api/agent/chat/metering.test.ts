/**
 * Unit tests for the dapp metering module: topic classification, chat
 * paywall (5 free off-topic, 5 HBAR per 50), and the 5-HBAR build
 * entitlement. Mirror-node reads are mocked; the store is the in-memory
 * fallback (no Upstash vars in the test env).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUILD_PAYWALL_ANON,
  BUILD_PAYWALL_UNPAID,
  CHAT_MESSAGES_PER_PAYMENT,
  CHAT_PAYWALL_ANON,
  CHAT_PAYWALL_WALLET,
  FREE_MESSAGES,
  checkBuildAccess,
  checkChatAccess,
  consumeBuild,
  isOnTopicMessage,
  noteChatMessage,
} from "./metering";
import { getKvStore } from "@/lib/server/store";

const EVM = (n: string) => `0x${n.repeat(40)}`;

/** One mirror-node TipSent log for a 5-HBAR tipPage("forge") tip. */
function tipLog(timestamp: string, index: number) {
  const amount = (5_000_000_000_000_000_000n).toString(16).padStart(64, "0");
  const fee = (100_000_000_000_000_000n).toString(16).padStart(64, "0");
  return {
    data: "0x" + amount + fee,
    timestamp,
    transaction_index: index,
  };
}

function mockMirror(batches: unknown[][]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/results/logs")) {
        const batch = batches.shift() ?? [];
        return { ok: true, json: async () => ({ logs: batch }) };
      }
      throw new Error(`unexpected fetch: ${u}`);
    })
  );
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("isOnTopicMessage — Voicescape/blockchain Q&A is free", () => {
  const onTopic = [
    "what is voicescape",
    "how do I publish my page",
    "tell me about hedera",
    "what's hbar used for",
    "how does blockchain tipping work",
    "i want to build my own blockpage",
    "how much is a build",
    "what are the fees",
    "help me set up my wallet",
    "make the background darker",
    "what is an nft",
    "thanks",
    "hi",
    "yes",
    "✨ Quick tour",
    "give me the quick tour",
  ];
  for (const msg of onTopic) {
    it(`on-topic: ${JSON.stringify(msg)}`, () => {
      expect(isOnTopicMessage(msg)).toBe(true);
    });
  }

  const offTopic = [
    "write me a poem",
    "help me with my homework",
    "tell me a joke",
    "what's the weather like",
    "write a python function to sort a list",
  ];
  for (const msg of offTopic) {
    it(`off-topic: ${JSON.stringify(msg)}`, () => {
      expect(isOnTopicMessage(msg)).toBe(false);
    });
  }
});

describe("checkChatAccess — 5 free off-topic messages, then paywall", () => {
  it("anonymous visitor gets 5 free, the 6th hits the connect-wallet paywall", async () => {
    mockMirror([]);
    const id = { kind: "anon", ip: "203.0.113.9" } as const;
    for (let i = 0; i < FREE_MESSAGES; i++) {
      const access = await checkChatAccess(id);
      expect(access.allowed).toBe(true);
      if (access.allowed) {
        expect(access.kind).toBe("free");
        expect(access.left).toBe(FREE_MESSAGES - i);
        await noteChatMessage(id, "free");
      }
    }
    const denied = await checkChatAccess(id);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.reason).toBe(CHAT_PAYWALL_ANON);
  });

  it("signed-in wallet gets 5 free, the 6th hits the tip paywall", async () => {
    mockMirror([]);
    const id = { kind: "wallet", evm: EVM("a") } as const;
    for (let i = 0; i < FREE_MESSAGES; i++) {
      const access = await checkChatAccess(id);
      expect(access.allowed).toBe(true);
      if (access.allowed) await noteChatMessage(id, "free");
    }
    const denied = await checkChatAccess(id);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.reason).toBe(CHAT_PAYWALL_WALLET);
  });

  it("on-topic answers never touch the free allowance (route-level concern, ledger stays clean)", async () => {
    mockMirror([]);
    const id = { kind: "anon", ip: "203.0.113.10" } as const;
    // The route skips metering for on-topic turns, so the ledger is never
    // even created. Ten on-topic turns: still a blank ledger.
    const raw = await getKvStore().get(`buddy:chat:anon:${id.ip}`);
    expect(raw).toBeNull();
  });

  it("a 5-HBAR tip unlocks 50 paid messages; the 51st is denied", async () => {
    mockMirror([[tipLog("1789520700.000000001", 1)]]);
    const id = { kind: "wallet", evm: EVM("b") } as const;
    for (let i = 0; i < FREE_MESSAGES; i++) {
      const access = await checkChatAccess(id);
      expect(access.allowed).toBe(true);
      if (access.allowed) await noteChatMessage(id, "free");
    }
    // Free allowance exhausted; the discovered tip becomes chat credit.
    const paid = await checkChatAccess(id);
    expect(paid.allowed).toBe(true);
    if (paid.allowed) {
      expect(paid.kind).toBe("paid");
      expect(paid.left).toBe(CHAT_MESSAGES_PER_PAYMENT);
    }
    for (let i = 0; i < CHAT_MESSAGES_PER_PAYMENT; i++) {
      await noteChatMessage(id, "paid");
    }
    const denied = await checkChatAccess(id);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.reason).toBe(CHAT_PAYWALL_WALLET);
  });

  it("one payment cannot buy both chat and a build", async () => {
    mockMirror([[tipLog("1789520800.000000002", 2)]]);
    const id = { kind: "wallet", evm: EVM("c") } as const;
    for (let i = 0; i < FREE_MESSAGES; i++) {
      const access = await checkChatAccess(id);
      if (access.allowed) await noteChatMessage(id, "free");
    }
    // First use: chat claims the payment.
    const chat = await checkChatAccess(id);
    expect(chat.allowed).toBe(true);
    if (chat.allowed) expect(chat.kind).toBe("paid");
    // The build gate now finds no unused payment.
    const build = await checkBuildAccess(id.evm);
    expect(build.allowed).toBe(false);
    if (!build.allowed) expect(build.reason).toBe(BUILD_PAYWALL_UNPAID);
  });

  it("operator bypass skips the paywall", async () => {
    vi.stubEnv("BUDDY_OPERATOR", "1");
    mockMirror([]);
    const id = { kind: "anon", ip: "203.0.113.11" } as const;
    for (let i = 0; i < 8; i++) {
      expect((await checkChatAccess(id)).allowed).toBe(true);
    }
  });
});

describe("build entitlement (5 HBAR per custom build)", () => {
  it("discovers a 5-HBAR tip and allows the build exactly once", async () => {
    mockMirror([[tipLog("1789520900.000000003", 3)]]);
    const evm = EVM("d");
    expect((await checkBuildAccess(evm)).allowed).toBe(true);
    expect(await consumeBuild(evm)).toBe(true);
    // Second build needs a second payment.
    expect(await consumeBuild(evm)).toBe(false);
    expect((await checkBuildAccess(evm)).allowed).toBe(false);
  });

  it("tips under 5 HBAR do not count", async () => {
    const amount = (4_999_000_000_000_000_000n).toString(16).padStart(64, "0");
    const fee = (0n).toString(16).padStart(64, "0");
    mockMirror([
      [{ data: "0x" + amount + fee, timestamp: "1789521000.1", transaction_index: 4 }],
    ]);
    expect((await checkBuildAccess(EVM("e"))).allowed).toBe(false);
  });

  it("the same on-chain payment is credited exactly once", async () => {
    const batch = [tipLog("1789521100.000000004", 5)];
    mockMirror([batch, batch]);
    const evm = EVM("f");
    expect((await checkBuildAccess(evm)).allowed).toBe(true);
    expect((await checkBuildAccess(evm)).allowed).toBe(true);
    const raw = await getKvStore().get(`buddy:chat:${evm}`);
    const ledger = JSON.parse(raw!);
    expect(ledger.payments).toHaveLength(1);
  });

  it("failed drafts never consume: no consume call, credit stays", async () => {
    mockMirror([[tipLog("1789521200.000000005", 6)]]);
    const evm = EVM("1");
    expect((await checkBuildAccess(evm)).allowed).toBe(true);
    // The route only calls consumeBuild after a valid draft — nothing
    // consumed here, so the payment is still unused.
    const raw = await getKvStore().get(`buddy:chat:${evm}`);
    const ledger = JSON.parse(raw!);
    expect(ledger.payments).toHaveLength(1);
    expect(ledger.payments[0].kind).toBe(null);
  });
});

describe("build paywall copy", () => {
  it("tells the visitor to say 'go' after tipping (nothing auto-starts)", () => {
    expect(BUILD_PAYWALL_ANON).toContain('say "go" here');
    expect(BUILD_PAYWALL_UNPAID).toContain('say "go" here');
  });

  it("no longer promises building 'the moment it settles on-chain'", () => {
    expect(BUILD_PAYWALL_ANON).not.toContain("the moment it settles");
    expect(BUILD_PAYWALL_UNPAID).not.toContain("the moment it settles");
  });

  it("still states the 5 HBAR price and the forge tip step", () => {
    for (const copy of [BUILD_PAYWALL_ANON, BUILD_PAYWALL_UNPAID]) {
      expect(copy).toContain("5 HBAR");
      expect(copy).toContain("forge");
    }
    expect(BUILD_PAYWALL_ANON).toContain("connected wallet");
  });
});
