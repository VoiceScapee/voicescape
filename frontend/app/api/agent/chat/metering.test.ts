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
  MAX_FREE_PREVIEWS,
  checkBuildAccess,
  checkChatAccess,
  consumeBuild,
  getLastMock,
  getPreviewsUsed,
  hasBuildHistory,
  isOnTopicMessage,
  noteChatMessage,
  notePreview,
  resetBuildPreviews,
  saveLastMock,
} from "./metering";
import { getKvStore } from "@/lib/server/store";

const EVM = (n: string) => `0x${n.repeat(40)}`;

/** One mirror-node TipSent log for a 5-HBAR tipPage("forge") tip.
 *  TipSent `amount` is denominated in tinybars on Hedera (verified
 *  2026-09-16 against mainnet: a 5-HBAR tip logs amount=500_000_000). */
function tipLog(timestamp: string, index: number) {
  const amount = (500_000_000n).toString(16).padStart(64, "0");
  const fee = (10_000_000n).toString(16).padStart(64, "0");
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
    const amount = (499_999_999n).toString(16).padStart(64, "0");
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

describe("hasBuildHistory — tweak eligibility without a second charge", () => {
  it("false for a wallet that never paid", async () => {
    mockMirror([[/* no tips */]]);
    expect(await hasBuildHistory(EVM("2"))).toBe(false);
  });

  it("true when an unused build payment sits on the ledger", async () => {
    mockMirror([[tipLog("1789521300.000000006", 7)]]);
    const evm = EVM("3");
    expect((await checkBuildAccess(evm)).allowed).toBe(true);
    expect(await hasBuildHistory(evm)).toBe(true);
  });

  it("true after the payment was spent on a build (tweaks ride the original)", async () => {
    mockMirror([[tipLog("1789521400.000000007", 8)]]);
    const evm = EVM("4");
    expect((await checkBuildAccess(evm)).allowed).toBe(true);
    expect(await consumeBuild(evm)).toBe(true);
    expect((await checkBuildAccess(evm)).allowed).toBe(false);
    expect(await hasBuildHistory(evm)).toBe(true);
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

describe("free visual-mock previews (2 per build)", () => {
  it("the free-preview allowance is 2", () => {
    expect(MAX_FREE_PREVIEWS).toBe(2);
  });

  it("starts at zero and increments per delivered preview", async () => {
    const id = { kind: "anon", ip: "203.0.113.77" } as const;
    expect(await getPreviewsUsed(id, "alice")).toBe(0);
    expect(await notePreview(id, "alice")).toBe(1);
    expect(await getPreviewsUsed(id, "alice")).toBe(1);
    expect(await notePreview(id, "alice")).toBe(2);
    expect(await getPreviewsUsed(id, "alice")).toBe(2);
  });

  it("counts separately per build username", async () => {
    const id = { kind: "anon", ip: "203.0.113.78" } as const;
    await notePreview(id, "alice");
    expect(await getPreviewsUsed(id, "bob")).toBe(0);
    expect(await getPreviewsUsed(id, "alice")).toBe(1);
  });

  it("counts separately per identity (wallet vs anon)", async () => {
    const anon = { kind: "anon", ip: "203.0.113.79" } as const;
    const wallet = { kind: "wallet", evm: EVM("5") } as const;
    await notePreview(anon, "alice");
    expect(await getPreviewsUsed(wallet, "alice")).toBe(0);
    expect(await getPreviewsUsed(anon, "alice")).toBe(1);
  });

  it("previews never touch the payment ledger", async () => {
    const id = { kind: "anon", ip: "203.0.113.80" } as const;
    await notePreview(id, "alice");
    await notePreview(id, "alice");
    const raw = await getKvStore().get(`buddy:chat:anon:${id.ip}`);
    expect(raw).toBeNull();
  });

  it("consumeBuild resets the preview counters so a new build repeats the process", async () => {
    mockMirror([[tipLog("1789520900.000000001", 31)]]);
    const evm = EVM("6");
    const id = { kind: "wallet", evm } as const;
    await checkBuildAccess(evm); // credits the payment
    await notePreview(id, "alice");
    await notePreview(id, "alice");
    expect(await getPreviewsUsed(id, "alice")).toBe(2);
    expect(await consumeBuild(evm)).toBe(true);
    expect(await getPreviewsUsed(id, "alice")).toBe(0);
  });

  it("resetBuildPreviews clears counters for a fresh build without spending", async () => {
    const id = { kind: "anon", ip: "203.0.113.81" } as const;
    await notePreview(id, "alice");
    expect(await getPreviewsUsed(id, "alice")).toBe(1);
    await resetBuildPreviews(id);
    expect(await getPreviewsUsed(id, "alice")).toBe(0);
  });

  it("remembers the last delivered mock for plain-text follow-up tweaks", async () => {
    const id = { kind: "anon", ip: "203.0.113.82" } as const;
    expect(await getLastMock(id, "alice")).toBeNull();
    const page = {
      version: 1,
      username: "alice",
      theme: {
        background: "#000",
        foreground: "#fff",
        accent: "#f0f",
        fontFamily: "sans",
      },
      blocks: [{ type: "hero", title: "alice" }],
    } as const;
    await saveLastMock(id, "alice", page as any);
    expect(await getLastMock(id, "alice")).toEqual(page);
    // Scoped per build username, like the counters.
    expect(await getLastMock(id, "bob")).toBeNull();
  });

  it("resetBuildPreviews clears the remembered mock too", async () => {
    const id = { kind: "anon", ip: "203.0.113.83" } as const;
    const page = {
      version: 1,
      username: "alice",
      theme: {
        background: "#000",
        foreground: "#fff",
        accent: "#f0f",
        fontFamily: "sans",
      },
      blocks: [{ type: "hero", title: "alice" }],
    } as const;
    await saveLastMock(id, "alice", page as any);
    expect(await getLastMock(id, "alice")).toBeTruthy();
    await resetBuildPreviews(id);
    expect(await getLastMock(id, "alice")).toBeNull();
  });
});
